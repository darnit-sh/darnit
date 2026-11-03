import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const file = "coverage-thresholds.json";
const config = `import thresholds from "./${file}" with { type: "json" };\n`;
const thresholds = { "src/scan/**": { lines: 90, branches: 80 }, "src/fix.ts": { lines: 70, branches: 60 } };
type Files = Record<string, string | undefined>;

/** A repo whose base commit holds `base` and whose head commit applies `head` over it; undefined removes a file. */
async function repo(base: Files, head: Files) {
  const dir = await mkdtemp(join(tmpdir(), "darnit-coverage-"));
  tempDirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  const commit = async (files: Files) => {
    for (const [f, text] of Object.entries(files)) await (text === undefined ? rm(join(dir, f)) : writeFile(join(dir, f), text));
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", "c");
    return git("rev-parse", "HEAD");
  };
  return { dir, base: await commit(base), head: await commit(head) };
}

async function gate(head: Files, base: Files = { [file]: JSON.stringify(thresholds), "vitest.config.ts": config }) {
  const r = await repo(base, head);
  const summary = join(r.dir, ".git", "summary");
  const run = spawnSync("sh", [resolve("scripts/check-coverage.sh"), r.base, r.head], {
    cwd: r.dir,
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
  });
  return { status: run.status, out: run.stdout, summary: await readFile(summary, "utf8").catch(() => "") };
}

const withThresholds = (t: object): Files => ({ [file]: JSON.stringify(t) });

describe("the coverage gate", () => {
  it("passes thresholds that stay, go up or gain a folder or metric", async () => {
    expect((await gate({})).status).toBe(0);
    const raised = await gate(withThresholds({ ...thresholds, "src/fix.ts": { lines: 71, branches: 60, functions: 50 }, "src/git.ts": { lines: 1 } }));
    expect(raised.status).toBe(0);
    expect(raised.summary).toContain("every threshold in base's coverage-thresholds.json stays or goes up");
  });

  it("fails a lowered threshold and names the folder, metric and both values", async () => {
    const r = await gate(withThresholds({ ...thresholds, "src/scan/**": { lines: 90, branches: 79 } }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("- src/scan/** branches 80 to 79");
    expect(r.summary).toContain("coverage thresholds only go up");
  });

  it("fails a folder or metric removed, renamed or made something other than a number", async () => {
    const cases: [object, string][] = [
      [{ "src/fix.ts": thresholds["src/fix.ts"] }, "- src/scan/** (removed)"],
      [{ "src/fix.ts": thresholds["src/fix.ts"], "src/scan/*.ts": thresholds["src/scan/**"] }, "- src/scan/** (removed)"],
      [{ ...thresholds, "src/fix.ts": { lines: 70 } }, "- src/fix.ts branches 60 to (none)"],
      [{ ...thresholds, "src/fix.ts": { lines: "99", branches: 60 } }, '- src/fix.ts lines 70 to "99"'],
      [{ ...thresholds, "src/fix.ts": 100 }, "- src/fix.ts (removed)"],
    ];
    for (const [t, line] of cases) {
      const r = await gate(withThresholds(t));
      expect(r.status, line).toBe(1);
      expect(r.out).toContain(line);
    }
  });

  it("fails a thresholds file head removes or leaves unreadable", async () => {
    for (const text of [undefined, "{", "[]", "null"]) {
      const r = await gate({ [file]: text });
      expect(r.status, String(text)).toBe(1);
      expect(r.out).toContain(`- ${file} (removed or unreadable)`);
    }
  });

  it("fails a vitest config that no longer reads the thresholds file", async () => {
    for (const text of [undefined, "export default {};\n"]) {
      const r = await gate({ "vitest.config.ts": text });
      expect(r.status, String(text)).toBe(1);
      expect(r.out).toContain(`- vitest.config.ts no longer reads ${file}`);
    }
  });

  it("passes when base has no thresholds file, so it starts judging once one lands", async () => {
    expect((await gate(withThresholds({}), { "vitest.config.ts": "export default {};\n" })).status).toBe(0);
  });

  it("judges an unreadable base as no thresholds rather than failing every change", async () => {
    expect((await gate(withThresholds({}), { [file]: "{", "vitest.config.ts": config })).status).toBe(0);
  });
});

// The matcher vitest groups files by for its thresholds.
const picomatch = createRequire(import.meta.url)("picomatch") as (glob: string) => (path: string) => boolean;

describe("the coverage thresholds", () => {
  it("put every source file in exactly one folder's line", async () => {
    const globs = Object.keys(JSON.parse(await readFile(file, "utf8")) as object).map(picomatch);
    const files = (await readdir("src", { recursive: true })).filter((f) => f.endsWith(".ts")).map((f) => posix.join("src", f.replaceAll("\\", "/")));
    expect(files.length).toBeGreaterThan(20);
    expect(files.filter((f) => globs.filter((matches) => matches(f)).length !== 1)).toEqual([]);
  });
});
