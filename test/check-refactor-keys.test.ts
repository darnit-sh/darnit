import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The rule reads the package name in an override key the pull request's author writes. Each key is 80,000
// characters; a line break at the end made the old regex start again at every @ and take seconds.
const KEYS = ["@".repeat(80_000), `${"@".repeat(80_000)}\n`, `${"a@".repeat(40_000)}\n`];
const LIMIT_MS = 1500;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** check-refactor.sh on a repo whose head commit adds an npm: alias under `key` in package.json's overrides. */
async function run(key: string) {
  const dir = await mkdtemp(join(tmpdir(), "darnit-rule-key-"));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" }).trim();
  const commit = async (json: object) => {
    await writeFile(join(dir, "package.json"), `${JSON.stringify(json)}\n`);
    git("add", ".");
    git("commit", "-q", "-m", "x");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  const deps = { dependencies: { zod: "4.6.6" } };
  const base = await commit(deps);
  const head = await commit({ ...deps, overrides: { [key]: "npm:zod@4.6.6" } });
  const summary = join(dir, ".git", "summary");
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "GITHUB_ACTIONS"));
  const start = performance.now();
  const { status } = spawnSync("sh", [resolve("scripts/check-refactor.sh"), base, head], {
    cwd: dir,
    env: { ...env, TITLE: "chore: x", BODY: "", GITHUB_STEP_SUMMARY: summary },
    stdio: "ignore",
  });
  return { status, ms: performance.now() - start, summary: await readFile(summary, "utf8") };
}

describe("the rule on a crafted override key", () => {
  it(`reads the package name in under ${LIMIT_MS} ms`, async () => {
    for (const key of KEYS) {
      const { status, ms, summary } = await run(key);
      expect(status).toBe(1);
      expect(summary).toContain('"npm:zod@4.6.6" (an alias to zod)');
      expect(ms, JSON.stringify(key.slice(-3))).toBeLessThan(LIMIT_MS);
    }
  });
});
