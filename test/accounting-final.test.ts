import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml, stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { marked, readCeiling, readNotCovered } from "../scripts/accounting-final.js";
import { parseSpec } from "../src/corpus/spec.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const tsx = join(ROOT, "node_modules", ".bin", "tsx");
// The fixture corpus has 4 items marked needs-record among its 9 items.
const FIXTURE = join(ROOT, "test", "fixtures", "accounting");
const CEILING = join("packs", "openai", "record-ceiling.txt");
const NOT_COVERED = join("packs", "openai", "not-covered.yaml");
const SPEC = join("corpus", "openai", "openapi.yaml");

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A copy of the fixture corpus with these files written into it (undefined leaves one out). */
async function corpus(files: Record<string, string | undefined> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "darnit-final-"));
  tempDirs.push(dir);
  await cp(FIXTURE, dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) if (text !== undefined) await writeFile(join(dir, file), text);
  return dir;
}

async function accounting(dir: string, ...args: string[]) {
  const run = await promisify(execFile)(tsx, ["scripts/accounting.ts", "--root", dir, ...args], { cwd: ROOT }).then(
    (r) => ({ ...r, code: 0 }),
    (e: { stdout: string; stderr: string; code: number }) => e,
  );
  return { stdout: run.stdout, stderr: run.stderr, status: run.code };
}

const lastLine = (stdout: string) => stdout.trimEnd().split("\n").at(-1);

describe("npm run accounting --final", () => {
  it("fails above the ceiling and passes at or below it, naming both numbers", async () => {
    const at = (n: string) => `the ceiling of ${n} in packs/openai/record-ceiling.txt`;
    const [above, equal, below] = await Promise.all(
      ["3\n", "4\n", "5\n"].map(async (c) => accounting(await corpus({ [CEILING]: c }), "--final")),
    );
    expect([above!.status, lastLine(above!.stdout)]).toEqual([1, `openai: 4 need a record, above ${at("3")}`]);
    expect([equal!.status, lastLine(equal!.stdout)]).toEqual([0, `openai: 4 need a record, at ${at("4")}`]);
    expect([below!.status, lastLine(below!.stdout)]).toEqual([
      0,
      `openai: 4 need a record, below ${at("5")}; lower it to 4`,
    ]);
  });

  it("fails on a ceiling that is missing, empty, negative, not a whole number or above every item", async () => {
    const bad = {
      missing: undefined,
      empty: "",
      negative: "-1\n",
      word: "four\n",
      decimal: "4.0\n",
      "leading zero": "04\n",
      spaced: " 4\n",
      "two lines": "4\n4\n",
      huge: `${"9".repeat(400)}\n`,
      "above the 9 items": "10\n",
    };
    const runs = await Promise.all(
      Object.values(bad).map(async (c) => accounting(await corpus({ [CEILING]: c }), "--final")),
    );
    expect(runs.map((r) => [r.status, lastLine(r.stdout)])).toEqual([
      [1, "openai: packs/openai/record-ceiling.txt is missing"],
      ...Array.from({ length: 7 }, () => [1, "openai: packs/openai/record-ceiling.txt does not hold one whole number"]),
      [1, "openai: packs/openai/record-ceiling.txt holds a number too large to count to"],
      [1, "openai: the ceiling of 10 in packs/openai/record-ceiling.txt is above all 9 items accounting reads"],
    ]);
    // Up to the ceiling itself, a ceiling equal to every item is a number like any other.
    expect(await readCeiling(await corpus({ [CEILING]: "9\r\n" }), "openai")).toBe(9);
  });

  it("is zero once every open item has a record or a reason", async () => {
    const swept = (await readFile(join(FIXTURE, NOT_COVERED), "utf8"))
      .replace(/^ {2}date: .*\n/gm, "")
      .replaceAll("needs-record:", "reason:");
    const dir = await corpus({ [CEILING]: "0\n", [NOT_COVERED]: swept });
    const notes = join(dir, "notes.md");
    const run = await accounting(dir, "--final", "--notes", notes);
    expect([run.status, lastLine(run.stdout)]).toEqual([
      0,
      "openai: 0 need a record, at the ceiling of 0 in packs/openai/record-ceiling.txt",
    ]);
    expect(await readFile(notes, "utf8")).toBe("## openai: 0 open, each needing a record\n\nNone.\n");
  });

  it("leaves the plain run as it was, whatever the ceiling file holds", async () => {
    const plain = await accounting(await corpus());
    expect(plain.status).toBe(0);
    for (const c of ["4\n", "garbage", "1\n"]) {
      const dir = await corpus({ [CEILING]: c });
      expect(await accounting(dir)).toEqual(plain);
      // --final prints the plain run's output, then its verdict.
      expect((await accounting(dir, "--final")).stdout.startsWith(plain.stdout.trimEnd())).toBe(true);
    }
  });

  it("refuses --notes without --final or without a file", async () => {
    const dir = await corpus({ [CEILING]: "4\n" });
    for (const args of [
      ["--notes", join(dir, "notes.md")],
      ["--final", "--notes"],
      ["--notes", "--final"],
    ]) {
      const run = await accounting(dir, ...args);
      expect([run.status, lastLine(run.stdout)]).toEqual([1, 'accounting stopped: "--notes <file> goes with --final"']);
    }
    await expect(readFile(join(dir, "notes.md"))).rejects.toThrow("ENOENT");
  });

  it("writes the open items to the notes in the printed order, with no name able to forge a line or Markdown", async () => {
    const hostile = [
      "evil\n- forged\n## heading",
      "`code` *em* _u_ [a](javascript:x) <img src=x> &amp; | ~ \\ !",
      "‮rtl",
    ];
    const spec = parseSpec(await readFile(join(FIXTURE, SPEC), "utf8"));
    const props = spec.components!.schemas!.CreateImageRequest!.properties!;
    for (const name of hostile) props[name] = { type: "string", deprecated: true };
    const entry = {
      items: hostile.map((n) => `schema CreateImageRequest property ${n}`),
      date: "2027-01-01",
      "needs-record": "Report-only.\n## forged [x](y) <b>",
    };
    const notCovered = `${await readFile(join(FIXTURE, NOT_COVERED), "utf8")}\n${stringify([entry])}`;
    const dir = await corpus({ [CEILING]: "7\n", [SPEC]: JSON.stringify(spec), [NOT_COVERED]: notCovered });
    const notes = join(dir, "notes.md");
    const run = await accounting(dir, "--final", "--notes", notes);
    expect(run.status).toBe(0);

    const lines = (await readFile(notes, "utf8")).split("\n");
    expect(lines.slice(0, 2)).toEqual(["## openai: 7 open, each needing a record", ""]);
    const body = lines.slice(2, -1);
    expect(lines.at(-1)).toBe("");
    // Every line is an entry or a key under it, and nothing in one is Markdown once its escapes are read.
    for (const line of body) {
      expect(line).toMatch(/^( {2})?- \S/);
      expect(line.replace(/^( {2})?- /, "").replace(/\\[!-/:-@[-`{-~]/g, "")).toMatch(/^[\w ]*$/);
    }
    expect(body).toContain("- 2027\\-01\\-01\\: Report\\-only\\. \\#\\# forged \\[x\\]\\(y\\) \\<b\\>");
    const unescape = (l: string) => l.replace(/\\([!-/:-@[-`{-~])/g, "$1");
    const printed = run.stdout.split("\n").filter((l) => /^ {6}"/.test(l));
    expect(body.filter((l) => l.startsWith("  - ")).map((l) => unescape(l.slice(4)))).toEqual(
      printed.map((l) => l.trim()),
    );
    expect(printed).toContain('      "schema CreateImageRequest property evil\\n- forged\\n## heading"');
    expect(printed).toContain('      "schema CreateImageRequest property \\u202ertl"');
  });

  it("holds each vendor's committed ceiling at the items its not-covered file marks needs-record", async () => {
    // Not the committed corpus, which a refresh changes: the ceiling and the not-covered file are both written by
    // hand, and while `npm run accounting` passes, the items marked needs-record are exactly the open ones. A
    // change that gives an open item a record or a reason lowers the ceiling with it; one that raises it shows here.
    const vendors = Object.keys(parseYaml(await readFile(join(ROOT, "vendors.yml"), "utf8")) as object);
    for (const vendor of vendors)
      expect([vendor, await readCeiling(ROOT, vendor)]).toEqual([vendor, marked(await readNotCovered(ROOT, vendor))]);
  });
});
