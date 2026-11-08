import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { pageRowsJson } from "../src/corpus/page-rows.js";
import { modelDetection, modelNotes, readPage } from "../src/corpus/replacements.js";
import { parseSpec } from "../src/corpus/spec.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE = join(ROOT, "test", "fixtures", "accounting");
const PAGE = "https://example.com/deprecations";
// Paths inside each test's copy of the fixture, never the committed corpus.
const ROWS = join("corpus", "openai", "page-rows.json");
const SPEC = join("corpus", "openai", "openapi.yaml");
const NON_MODEL = join("corpus", "openai", "non-model-rows.txt");
const local = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "GITHUB_ACTIONS"));
// The fixture's spec lists no model, so the page's replacement is for a person.
const HUMAN = "not a plain swap: OpenAI recommends zzq-new, which its API spec does not list";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** A model record shutting down on 2027-03-01, with the page's notes and replacement unless given others. */
function record(model: string, change: { replacement?: object; replacedBy?: string } = {}) {
  const page = readPage(table([[model, change.replacedBy ?? "zzq-new"]]));
  return {
    id: `openai:2026-11-01:${model}-shut-down`,
    title: `${model} shut down on 2027-03-01`,
    status: "candidate",
    vendor: "openai",
    announcedAt: "2026-11-01",
    effectiveAt: "2027-03-01",
    kind: "breaking",
    surface: { endpoints: ["/v1/chat/completions"], sdkSymbols: ["chat.completions.create"], fields: ["model"] },
    classification: "semantic",
    sources: [{ url: PAGE }],
    notes: { migration: modelNotes("OpenAI", [model], "2027-03-01", page) },
    detection: modelDetection([model]),
    fix: { models: { [model]: change.replacement ?? { human: HUMAN, source: PAGE } } },
  };
}

const table = (rows: string[][]) =>
  `<table><tr><th>Shutdown date</th><th>Model</th><th>Recommended replacement</th></tr>${rows
    .map(([m, to]) => `<tr><td>2027-03-01</td><td>${m}</td><td>${to}</td></tr>`)
    .join("")}</table>`;

// The header row of every page table() writes, an item like any other row, given a reason in every corpus below.
const HEAD = 'page no date read row ["Shutdown date","Model","Recommended replacement"]';
const NOT_COVERED = join("packs", "openai", "not-covered.yaml");
const CEILING = "packs/openai/record-ceiling.txt";
/** The fixture's not-covered file with the header's reason, and these keys marked needs-record. */
const notCovered = async (keys: string[] = []) =>
  `${await readFile(join(FIXTURE, NOT_COVERED), "utf8")}\n- items:\n    - ${JSON.stringify(HEAD)}\n  reason: A table's header row.\n${
    keys.length > 0
      ? `\n- items:\n${keys.map((k) => `    - ${JSON.stringify(k)}\n`).join("")}  date: "2027-03-01"\n  needs-record: A record for it.\n`
      : ""
  }`;

/**
 * The accounting fixture with a deprecations page whose rows retire these models for zzq-new, and any other tables
 * given, fetched `age` days ago, these records added and these files written.
 */
async function corpus(
  models: string[],
  records: object[] = [],
  files: Record<string, string> = {},
  age = 0,
  tables = "",
) {
  const dir = await mkdtemp(join(tmpdir(), "darnit-page-accounting-"));
  tempDirs.push(dir);
  await cp(FIXTURE, dir, { recursive: true });
  await writeFile(join(dir, "vendors.yml"), `${await readFile(join(FIXTURE, "vendors.yml"), "utf8")}  page: ${PAGE}\n`);
  const page = readPage(table(models.map((m) => [m, "zzq-new"])) + tables);
  await writeFile(join(dir, NOT_COVERED), await notCovered());
  await writeFile(join(dir, ROWS), pageRowsJson(page, { source: PAGE, fetchedAt: daysAgo(age) }));
  for (const r of records) {
    const pack = join(dir, "packs/openai", (r as { id: string }).id.split(":").pop()!);
    await mkdir(pack);
    await writeFile(join(pack, "change.json"), JSON.stringify(r));
  }
  for (const [file, text] of Object.entries(files)) await writeFile(join(dir, file), text);
  return dir;
}

async function accounting(dir: string, args: string[] = [], node: string[] = []) {
  const run = await promisify(execFile)(
    process.execPath,
    [...node, "--import", "tsx", "scripts/accounting.ts", "--root", dir, ...args],
    { cwd: ROOT, env: local },
  ).then(
    (r) => ({ ...r, code: 0 }),
    (e: { stdout: string; code: number }) => e,
  );
  return { out: run.stdout, code: run.code };
}

describe("npm run accounting and the deprecations page rows", () => {
  it("fails on a page model no record detects and no entry lists, naming it", async () => {
    const { out, code } = await accounting(await corpus(["zzq-old"]));
    expect(code).toBe(1);
    expect(out).toContain(", 2 items on the deprecations page fetched ");
    expect(out).toContain(
      `Not accounted for (add a record, or an entry in ${NOT_COVERED}):\n  "page 2027-03-01 zzq-old"`,
    );
  });

  it("counts a page model listed as needs-record as open, and one a record detects as covered", async () => {
    const dir = await corpus(["zzq-old", "zzq-two"], [record("zzq-two")], {
      [NOT_COVERED]: await notCovered(["page 2027-03-01 zzq-old"]),
    });
    const { out, code } = await accounting(dir);
    expect(out).toContain("  2 covered by records, 5 with a reason, 5 need a record, 0 unaccounted for\n");
    expect(out).toContain('- 2027-03-01: A record for it.\n      "page 2027-03-01 zzq-old"');
    expect(code).toBe(0);
  });

  it("fails on an entry for a page model a record detects, or one no longer on the page", async () => {
    const dir = await corpus(["zzq-two"], [record("zzq-two")], {
      [NOT_COVERED]: await notCovered(["page 2027-03-01 zzq-two", "page 2027-03-01 zzq-gone"]),
    });
    const { out, code } = await accounting(dir);
    expect(code).toBe(1);
    expect(out).toContain(
      'items a record covers (remove them):\n  "page 2027-03-01 zzq-two": openai:2026-11-01:zzq-two-shut-down',
    );
    expect(out).toContain('no longer in the spec or the corpus history (remove them):\n  "page 2027-03-01 zzq-gone"');
  });

  it("fails on a record whose replacements or notes are not what the page gives, naming each", async () => {
    const wrongFix = record("zzq-one", { replacement: { model: "zzq-other", source: PAGE } });
    const wrongNotes = record("zzq-two", { replacedBy: "zzq-older" });
    const { out, code } = await accounting(await corpus(["zzq-one", "zzq-two"], [wrongFix, wrongNotes]));
    expect(out).toContain(
      "Where the records and corpus/openai/page-rows.json disagree, as npm run replacements -- --rows corpus/openai/page-rows.json --check finds it (correct the records):",
    );
    expect(out).toContain('"openai:2026-11-01:zzq-one-shut-down: its replacements are not what the page gives"');
    expect(out).toContain(
      '"openai:2026-11-01:zzq-two-shut-down: notes say zzq-two to zzq-older, the page says zzq-new"',
    );
    expect(out).toContain("  3 covered by records, 5 with a reason, 4 need a record, 0 unaccounted for\n");
    expect(code).toBe(1);
  });

  it("refuses a final release on page rows fetched over 14 days ago or after today, and passes at 14 and 13", async () => {
    const final = async (age: number) => {
      const dir = await corpus(["zzq-two"], [record("zzq-two")], { [CEILING]: "4\n" }, age);
      return accounting(dir, ["--final"]);
    };
    const old = await final(15);
    expect(old.out.trimEnd().split("\n").at(-1)).toBe(
      `final release refused, openai: corpus/openai/page-rows.json was fetched on ${daysAgo(15)}, 15 days ago, over the 14 a final release allows; the weekly corpus run fetches it again; 4 need a record, at the ceiling of 4 in ${CEILING}`,
    );
    expect(old.code).toBe(1);
    expect((await final(-1)).out).toContain(`page-rows.json says it was fetched on ${daysAgo(-1)}, after today`);
    for (const age of [14, 13]) {
      const ok = await final(age);
      expect(ok.out.trimEnd().split("\n").at(-1)).toBe(
        `final release passes, openai: 4 need a record, at the ceiling of 4 in ${CEILING}`,
      );
      expect(ok.code).toBe(0);
    }
  });

  it("holds each row to its own entry, whatever quotes, commas and bars its cells hold", async () => {
    // Joined with " | ", the first two rows would share a key; quoted and joined with commas, the last two would.
    const rows: string[][] = [
      ["2027-03-01", "Agent | Builder"],
      ["2027-03-01", "Agent", "Builder"],
      ["2027-03-01", 'Agent","Builder'],
    ];
    const updates = `<table><tr><th>Date</th><th>Update</th><th>Note</th></tr>${rows
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
      .join("")}</table>`;
    const head = 'page no date read row ["Date","Update","Note"]';
    const keys = rows.map((r) => `page 2027-03-01 row ${JSON.stringify(r.slice(1))}`);
    const dir = await corpus(["zzq-two"], [record("zzq-two")], {}, 0, updates);
    const open = await accounting(dir);
    expect(open.out).toContain("  2 covered by records, 5 with a reason, 4 need a record, 4 unaccounted for\n");
    for (const key of [head, ...keys]) expect(open.out).toContain(`\n  ${JSON.stringify(key)}\n`);
    // An entry for one row stands for that row alone.
    await writeFile(join(dir, NOT_COVERED), await notCovered([head, keys[0]!]));
    expect((await accounting(dir)).out).toContain(
      "  2 covered by records, 5 with a reason, 6 need a record, 2 unaccounted for\n",
    );
  });

  it("reads the page with the spec's models and the non-model rows list, as npm run replacements does", async () => {
    // A rename to zzq-new holds only while the spec lists zzq-new; a row naming zzq-two that darnit does not read holds
    // only while non-model-rows.txt lists it.
    const renamed = record("zzq-two", { replacement: { model: "zzq-new", source: PAGE } });
    const unread = table([["Models like zzq-two", "zzq-new"]]);
    const folded = readPage(unread).rows[1]!.folded;
    const spec = parseSpec(await readFile(join(FIXTURE, SPEC), "utf8"));
    (spec.components!.schemas as Record<string, unknown>).ZzqModelIds = { type: "string", enum: ["zzq-new"] };
    // The row is an item like any other, listed as needing a record.
    const entry = { [NOT_COVERED]: await notCovered(['page 2027-03-01 row ["Models like zzq-two","zzq-new"]']) };
    const listed = { ...entry, [SPEC]: JSON.stringify(spec), [NON_MODEL]: `${folded}\n` };
    const passes = await accounting(await corpus(["zzq-two"], [renamed], listed, 0, unread));
    expect(passes.out).not.toContain("disagree");
    expect(passes.code).toBe(0);
    const noSpec = await accounting(
      await corpus(["zzq-two"], [renamed], { ...entry, [NON_MODEL]: `${folded}\n` }, 0, unread),
    );
    expect(noSpec.out).toContain('"openai:2026-11-01:zzq-two-shut-down: its replacements are not what the page gives"');
    const noList = await accounting(
      await corpus(["zzq-two"], [renamed], { ...entry, [SPEC]: JSON.stringify(spec) }, 0, unread),
    );
    expect(noList.out).toContain("may name zzq-two, which darnit did not read from it");
    expect([noSpec.code, noList.code]).toEqual([1, 1]);
  });

  it("holds the ceiling to every item, page models included", async () => {
    // 7 spec items, 2 removals and 2 page items (the header and the model): a ceiling of 11 is not above them all.
    const dir = await corpus(["zzq-two"], [record("zzq-two")], { [CEILING]: "11\n" });
    const { out, code } = await accounting(dir, ["--final"]);
    expect(out.trimEnd().split("\n").at(-1)).toBe(
      `final release passes, openai: 4 need a record, below the ceiling of 11 in ${CEILING}; lower it to 4`,
    );
    expect(code).toBe(0);
  });

  it("stops on page rows that are missing or not from the page vendors.yml names", async () => {
    const dir = await corpus(["zzq-two"], [record("zzq-two")]);
    const rows = join(dir, ROWS);
    await writeFile(rows, (await readFile(rows, "utf8")).replace(PAGE, "https://example.org/deprecations"));
    const other = await accounting(dir);
    expect(other.out).toContain(
      `accounting stopped: "the page rows file is not one darnit writes: source: not ${PAGE}"`,
    );
    expect(other.code).toBe(1);
    await rm(rows);
    const missing = await accounting(dir);
    expect(missing.out).toContain("accounting stopped: ");
    expect(missing.out).toContain("page-rows.json");
    expect(missing.code).toBe(1);
  });

  it("fetches nothing: no fetch, socket or name lookup, with the page rows read", async () => {
    const dir = await corpus(["zzq-two"], [record("zzq-two")], { [CEILING]: "4\n" });
    const log = join(dir, "network.log");
    const preload = join(dir, "no-network.cjs");
    // Every way out of the process to the network is logged and refused; a socket to a local pipe, as tsx opens to
    // talk to its own parent process, is let through.
    await writeFile(
      preload,
      `const fs = require("node:fs"), net = require("node:net"), dns = require("node:dns");
const refuse = (what) => { fs.appendFileSync(${JSON.stringify(log)}, what + "\\n"); throw new Error("no network: " + what); };
globalThis.fetch = async (url) => refuse("fetch " + url);
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const to = Array.isArray(args[0]) ? args[0][0] : args[0];
  return typeof to?.path === "string" ? connect.apply(this, args) : refuse("socket " + JSON.stringify(to));
};
dns.lookup = (host) => refuse("lookup " + host);
dns.promises.lookup = async (host) => refuse("lookup " + host);
`,
    );
    // The probe itself catches a fetch, a socket and a name lookup.
    const probe = `fetch("https://example.com").catch(() => {});
for (const reach of [() => require("node:net").connect(1, "127.0.0.1"), () => require("node:dns").lookup("example.com", () => {})])
  try { reach(); } catch {}`;
    await promisify(execFile)(process.execPath, ["--require", preload, "-e", probe]);
    expect(await readFile(log, "utf8")).toBe(
      'fetch https://example.com\nsocket {"port":1,"host":"127.0.0.1"}\nlookup example.com\n',
    );
    await rm(log);
    for (const args of [[], ["--final"]]) {
      const { out, code } = await accounting(dir, args, ["--require", preload]);
      expect(out).toContain(", 2 items on the deprecations page fetched ");
      expect(code).toBe(0);
    }
    await expect(readFile(log, "utf8")).rejects.toThrow("ENOENT");
  });
});
