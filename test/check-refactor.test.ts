import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("scripts/check-refactor.sh");
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const baseFiles = [
  "src/a.ts",
  "test/a.test.ts",
  "test/golden/repo.txt",
  "packs/v/p/fixtures/basic/input.ts",
  "packs/v/p/rules/r.yml",
  "packs/v/p/change.json",
  "package.json",
  ".github/workflows/ci.yml",
];

type Edit = { write?: string; remove?: string; move?: [string, string] };

/** Runs the rule on a repo whose head commit applies `edits` to a base holding `baseFiles`. */
async function rule(title: string, edits: Edit[], body = "") {
  const dir = await mkdtemp(join(tmpdir(), "darnit-rule-"));
  tempDirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" }).trim();
  const write = async (f: string, text: string) => {
    await mkdir(dirname(join(dir, f)), { recursive: true });
    await writeFile(join(dir, f), text);
  };
  git("init", "-q");
  for (const f of baseFiles) await write(f, `${f}\n`);
  git("add", ".");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  for (const e of edits) {
    if (e.write) await write(e.write, "changed\n");
    if (e.remove) await rm(join(dir, e.remove));
    if (e.move) {
      await mkdir(dirname(join(dir, e.move[1])), { recursive: true });
      await rename(join(dir, e.move[0]), join(dir, e.move[1]));
    }
  }
  git("add", "-A");
  git("commit", "-q", "-m", "head");
  const head = git("rev-parse", "HEAD");
  const output = join(dir, "..", `${dir.split("/").pop()}.out`);
  tempDirs.push(output);
  await writeFile(output, "");
  const run = spawnSync("sh", [script, base, head], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, TITLE: title, BODY: body, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: "" },
  });
  return { status: run.status, out: run.stdout, baseTests: (await readFile(output, "utf8")).includes("base-tests=true") };
}

describe("the rule picked by the title's type", () => {
  it("fails a refactor that edits an existing test, golden file or fixture, or renames a test", async () => {
    for (const f of ["test/a.test.ts", "test/golden/repo.txt", "packs/v/p/fixtures/basic/input.ts"]) {
      const r = await rule("refactor: tidy", [{ write: "src/a.ts" }, { write: f }]);
      expect(r.status, f).toBe(1);
      expect(r.out).toContain(`(a) failed`);
      expect(r.out).toContain(`- ${f}`);
      expect(r.baseTests).toBe(false);
    }
    const moved = await rule("perf(scan): faster", [{ move: ["test/a.test.ts", "test/b.test.ts"] }]);
    expect(moved.status).toBe(1);
    expect(moved.out).toContain("- test/a.test.ts");
    expect((await rule("refactor: x", [{ remove: "test/golden/repo.txt" }])).status).toBe(1);
  });

  it("lets a refactor add tests, then asks for base's tests, unless the body opts out with a reason", async () => {
    const ok = await rule("refactor(scan)!: split", [{ write: "src/a.ts" }, { write: "test/new.test.ts" }]);
    expect(ok).toMatchObject({ status: 0, baseTests: true });
    expect(ok.out).toContain("(a) passed");
    const optOut = await rule("refactor: x", [{ write: "src/a.ts" }], "Text\r\nProof: none, renames an export the tests import\r\n");
    expect(optOut).toMatchObject({ status: 0, baseTests: false });
    expect(optOut.out).toContain("::warning::(b) skipped");
    expect(optOut.out).toContain("Reason given: renames an export the tests import");
    const short = await rule("refactor: x", [{ write: "src/a.ts" }], "Proof: none, because\n");
    expect(short).toMatchObject({ status: 0, baseTests: true });
    expect(short.out).toContain("reason needs at least 10 characters");
    const opted = await rule("refactor: x", [{ write: "test/a.test.ts" }], "Proof: none, renames an export\n");
    expect(opted.status).toBe(1);
  });

  it("fails test, docs, chore, ci and build changes that touch code, rules or a record", async () => {
    for (const [title, f] of [
      ["chore: tidy", "src/a.ts"],
      ["docs: tidy", "packs/v/p/rules/r.yml"],
      ["test: more", "packs/v/p/change.json"],
      ["ci: x", "src/new.ts"],
    ] as const) {
      const r = await rule(title, [{ write: f }]);
      expect(r.status, title).toBe(1);
      expect(r.out).toContain(`- ${f}`);
    }
    const moved = await rule("build: move", [{ move: ["src/a.ts", "lib/a.ts"] }]);
    expect(moved.status).toBe(1);
    expect(moved.out).toContain("- src/a.ts");
  });

  it("passes dependency and workflow bumps, and tests or docs that leave code alone", async () => {
    for (const [title, f] of [
      ["chore(deps): bump zod from 4.6.6 to 4.6.7 in the runtime group", "package.json"],
      ["chore(deps-dev): bump the tooling group with 2 updates", "package-lock.json"],
      ["build(deps): bump yaml", "package.json"],
      ["ci: bump actions/create-github-app-token from 3.2.0 to 3.3.0", ".github/workflows/ci.yml"],
      ["test: cover x", "test/a.test.ts"],
      ["docs: readme", "README.md"],
    ] as const) {
      const r = await rule(title, [{ write: f }]);
      expect(r, title).toMatchObject({ status: 0, baseTests: false });
      expect(r.out).toContain("**Passed:**");
    }
  });

  it("names the proof check for fix and feat, shows revert as exempt, and fails an unknown type", async () => {
    expect((await rule("fix: x", [{ write: "test/a.test.ts" }])).out).toContain("the proof check covers fix");
    expect((await rule("feat(packs): x", [{ write: "src/a.ts" }])).status).toBe(0);
    expect((await rule('revert: "refactor: x"', [{ write: "test/a.test.ts" }])).out).toContain("exempt");
    for (const title of ["Refactor: x", "wip: x", "refactor x", ""]) {
      expect((await rule(title, [{ write: "test/a.test.ts" }])).status, title).toBe(1);
    }
  });
});
