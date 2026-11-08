import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pageRowsJson, readPageRows } from "../src/corpus/page-rows.js";
import { readPage } from "../src/corpus/replacements.js";
import { sha256 } from "../src/corpus/spec.js";
import { loadRecords } from "../src/records/load.js";
import { recordModels } from "../src/records/schema.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE = readFile(join(ROOT, "test/fixtures/deprecations.html"), "utf8");
// A spec of its own, as the committed one changes with every refresh; the page's rows need no model it lists.
const SPEC = `openapi: 3.1.0\ninfo: { title: t, version: "1" }\npaths: {}\n`;
// Children print as they would for a person: GitHub's annotation format only shows under GITHUB_ACTIONS.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "GITHUB_ACTIONS"));

/** A script run from the repository, with any variables added, its exit code and everything it printed. */
const spawnScript = (args: string[], more: Record<string, string> = {}) =>
  promisify(execFile)(process.execPath, ["--import", "tsx", ...args], { cwd: ROOT, env: { ...env, ...more } }).then(
    (r) => ({ code: 0, out: r.stdout + r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }),
  );
const script = (...args: string[]) => spawnScript(args);

const planted = (html: string, table: string) => html.replace("</body>", `${table}</body>`);
const UNREADABLE = '<table><tr><th>Shutdown date</th></tr><tr><td style="color: red">gpt-4o</td></tr></table>';
const unknownRow = (model: string) =>
  `<table><tr><th>Shutdown date</th><th>Model</th><th>Recommended replacement</th></tr><tr><td>2027-03-01</td><td>Models like ${model}</td><td>gpt-6-luna</td></tr></table>`;
const MINI = "<td>GPT-4o mini (<code>gpt-4o-mini-2024-07-18</code>)</td> <td><code>gpt-6-luna</code>";
const GPT5 = "<td><code>gpt-5</code> | <code>gpt-5-2025-08-07</code></td>";
// A model the 2026-12-11 record detects only once its row adds it, and a row naming it that darnit does not read.
const zzq = (html: string) =>
  planted(
    html.replace(GPT5, "<td><code>gpt-5</code> | <code>gpt-5-2025-08-07</code> | <code>zzq-9</code></td>"),
    unknownRow("zzq-9"),
  );
const PAGE = "https://developers.openai.com/api/docs/deprecations";
const MODEL = (await loadRecords()).flatMap((l) => recordModels(l.record))[0]!;

/** Corpus runs in one folder whose vendors.yml names a local server for the spec and the page. */
async function corpusRoot() {
  const dir = await mkdtemp(join(tmpdir(), "darnit-page-rows-"));
  const spec = SPEC;
  let page = { status: 200, body: await FIXTURE };
  const server = createServer((req, res) =>
    req.url === "/openapi.yaml" ? res.end(spec) : res.writeHead(page.status).end(page.body),
  );
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const corpus = join(dir, "corpus", "openai");
  await mkdir(corpus, { recursive: true });
  await writeFile(join(dir, "vendors.yml"), `openai:\n  spec: ${at}/openapi.yaml\n  page: ${at}/deprecations\n`);
  await writeFile(join(corpus, "openapi.yaml"), spec);
  await writeFile(join(corpus, "snapshot.json"), JSON.stringify({ sha256: sha256(spec) }));
  await writeFile(join(corpus, "whole-rows.txt"), "2026-12-11\n");
  const rows = join(corpus, "page-rows.json");
  return {
    url: `${at}/deprecations`,
    rows,
    run: async (status: number, body: string, flags: string[] = [], more: Record<string, string> = {}) => {
      page = { status, body };
      const out = await spawnScript(["scripts/corpus.ts", "--root", dir, ...flags], more);
      return { ...out, saved: await readFile(rows, "utf8").catch(() => undefined) };
    },
    done: async () => {
      server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("npm run corpus and the deprecations page", () => {
  let at: Awaited<ReturnType<typeof corpusRoot>>;
  beforeAll(async () => void (at = await corpusRoot()));
  afterAll(() => at.done());

  it("saves the rows readPage reads from the page with the fetch date, the same bytes on a second run", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const first = await at.run(200, await FIXTURE);
    expect(first.code, first.out).toBe(0);
    expect(first.out).toContain("openai: saved corpus/openai/page-rows.json");
    const saved = readPageRows(first.saved!, at.url);
    expect(saved.page).toStrictEqual(readPage(await FIXTURE));
    expect([day, new Date().toISOString().slice(0, 10)]).toContain(saved.fetchedAt);
    const second = await at.run(200, await FIXTURE);
    expect(second.code, second.out).toBe(0);
    expect(second.saved).toBe(first.saved);
  });

  it.each([
    ["an unreadable table", () => FIXTURE.then((h) => planted(h, UNREADABLE)), "it holds a <td> with style"],
    [
      "a row naming a model darnit did not read",
      () => FIXTURE.then((h) => planted(h, unknownRow(MODEL))),
      `may name ${MODEL}, which darnit did not read from it`,
    ],
  ])("fails on %s, naming it, and keeps the saved rows", async (_, page, cause) => {
    const kept = await readFile(at.rows, "utf8");
    const out = await at.run(200, await page());
    expect(out.code).toBe(1);
    expect(out.out).toContain("openai: corpus/openai/page-rows.json not saved: the page has a table or row");
    expect(out.out).toContain(cause);
    expect(out.saved).toBe(kept);
  });

  it("fails when the page answers 500, naming the status, and keeps the saved rows", async () => {
    const kept = await readFile(at.rows, "utf8");
    const out = await at.run(500, await FIXTURE);
    expect(out.code).toBe(2);
    expect(out.out).toContain(`openai: corpus/openai/page-rows.json not saved: ${at.url} answered 500, not 200`);
    expect(out.saved).toBe(kept);
  });
});

describe("npm run corpus --dry-run", () => {
  it("reads the page and saves nothing", async () => {
    const at = await corpusRoot();
    try {
      const out = await at.run(200, await FIXTURE, ["--dry-run"]);
      expect(out.code, out.out).toBe(0);
      expect(out.out).toContain("openai: would save corpus/openai/page-rows.json");
      expect(out.saved).toBeUndefined();
    } finally {
      await at.done();
    }
  });
});

describe("npm run replacements with --rows", () => {
  const dir = mkdtemp(join(tmpdir(), "darnit-rows-"));
  afterAll(async () => rm(await dir, { recursive: true, force: true }));
  const about = { source: PAGE, fetchedAt: "2026-11-08" };

  it.each([
    ["the repository's copy of the page", () => FIXTURE, false],
    ["a page with a row darnit cannot read", () => FIXTURE.then((h) => planted(h, unknownRow(MODEL))), true],
    [
      "a page with a model in a cell darnit does not read it from",
      () => FIXTURE.then((h) => h.replace(MINI, `${MINI} gpt-4o-2024-08-06`)),
      true,
    ],
  ])("prints and exits the same from %s as --page does", async (name, html, fails) => {
    const [page, rows] = [join(await dir, `${fails}.html`), join(await dir, `${fails}.json`)];
    await writeFile(page, await html());
    await writeFile(rows, pageRowsJson(readPage(await html()), about));
    for (const flags of [[], ["--check"]]) {
      const fromPage = await script("scripts/replacements.ts", "--page", page, ...flags);
      expect(await script("scripts/replacements.ts", "--rows", rows, ...flags), `${name} ${flags.join(" ")}`).toEqual(
        fromPage,
      );
      // A whole run either way; the exit code on the repository's copy follows the committed records and spec.
      expect(fromPage.out).toContain("detected models:");
      if (fails) expect(fromPage.code).toBe(1);
    }
  });

  it("takes --page or --rows, not both and not neither", async () => {
    for (const flags of [[], ["--page", "a.html", "--rows", "a.json"]]) {
      const out = await script("scripts/replacements.ts", ...flags);
      expect(out.code).toBe(2);
      expect(out.out).toContain("usage: npm run replacements -- {--page <saved copy of");
      expect(out.out).toContain("| --rows corpus/openai/page-rows.json");
    }
  });
});

describe("the page check, the same in npm run corpus and npm run replacements", () => {
  it("fails both on a row naming a model the record of a whole-row date detects once its row adds it", async () => {
    const at = await corpusRoot();
    try {
      const html = zzq(await FIXTURE);
      const corpus = await at.run(200, html);
      expect(corpus.code, corpus.out).toBe(1);
      expect(corpus.out).toContain("may name zzq-9, which darnit did not read from it");
      expect(corpus.saved).toBeUndefined();
      const page = join(await mkdtemp(join(tmpdir(), "darnit-zzq-")), "page.html");
      await writeFile(page, html);
      const replacements = await script("scripts/replacements.ts", "--page", page);
      expect(replacements.code).toBe(1);
      expect(replacements.out).toContain("may name zzq-9, which darnit did not read from it");
      await rm(join(page, ".."), { recursive: true, force: true });
    } finally {
      await at.done();
    }
  });

  it("dates the rows in UTC wherever the run is, and prints page text escaped", async () => {
    const at = await corpusRoot();
    try {
      const day = new Date().toISOString().slice(0, 10);
      const dates: string[] = [];
      for (const TZ of ["Pacific/Kiritimati", "Etc/GMT+12"]) {
        const out = await at.run(200, await FIXTURE, [], { TZ });
        expect(out.code, out.out).toBe(0);
        dates.push(readPageRows(out.saved!, at.url).fetchedAt);
      }
      expect([day, new Date().toISOString().slice(0, 10)]).toContain(dates[0]);
      expect(dates[1]).toBe(dates[0]);
      const out = await at.run(200, planted(await FIXTURE, '<table><tr><td x\u202e="1">a</td></tr></table>'));
      expect(out.code).toBe(1);
      expect(out.out).toContain("it holds a <td> with x\\u202e where");
      expect(out.out).not.toContain("\u202e");
    } finally {
      await at.done();
    }
  });
});

describe("npm run replacements on a rows file darnit did not write", () => {
  it("refuses it, exiting 2 with a short escaped message and no stack", async () => {
    const dir = await mkdtemp(join(tmpdir(), "darnit-refused-"));
    try {
      const rows = JSON.parse(
        pageRowsJson(readPage(await FIXTURE), { source: PAGE, fetchedAt: "2026-11-08" }),
      ) as object;
      const files = {
        planted: { ...rows, "x\u202e": 1 },
        huge: { ...rows, tables: [{ cells: Array.from({ length: 200_000 }, () => [7]) }] },
        elsewhere: { ...rows, source: "https://example.com/deprecations" },
      };
      for (const [name, file] of Object.entries(files)) {
        await writeFile(join(dir, `${name}.json`), JSON.stringify(file));
        const out = await script("scripts/replacements.ts", "--rows", join(dir, `${name}.json`));
        expect(out.code, name).toBe(2);
        expect(out.out, name).toMatch(/^npm run replacements: .*: the page rows file is not one darnit writes: .*\n$/);
        expect(out.out.length, name).toBeLessThan(500);
        expect(out.out, name).not.toContain("\u202e");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
