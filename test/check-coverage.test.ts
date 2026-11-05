import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const file = "coverage-thresholds.json";
const config = `import thresholds from "./${file}" with { type: "json" };\nexport default { test: { coverage: { thresholds } } };\n`;
const thresholds = { "src/scan/**": { lines: 90, branches: 80 }, "src/fix.ts": { lines: 70, branches: 60 } };
const pkg = (plugin = "5.0.5", vitest = "^5.0.5") => JSON.stringify({ devDependencies: { "@vitest/coverage-v8": plugin, vitest } });
const lock = (plugin = "5.0.5", vitest = "5.0.5") =>
  JSON.stringify({ packages: { "node_modules/@vitest/coverage-v8": { version: plugin }, "node_modules/vitest": { version: vitest } } });
const baseFiles = {
  [file]: JSON.stringify(thresholds),
  "vitest.config.ts": config,
  "package.json": pkg(),
  "package-lock.json": lock(),
  "src/git.ts": "export const a = 1;\n/* v8 ignore next */\nexport const b = 2;\n",
};
type Files = Record<string, string | undefined>;

/** A repo whose base commit holds `base` and whose head commit applies `head` over it; undefined removes a file. */
async function repo(base: Files, head: Files) {
  const dir = await mkdtemp(join(tmpdir(), "darnit-coverage-"));
  tempDirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  const commit = async (files: Files) => {
    for (const [f, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, f)), { recursive: true });
      await (text === undefined ? rm(join(dir, f)) : writeFile(join(dir, f), text));
    }
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", "c");
    return git("rev-parse", "HEAD");
  };
  return { dir, base: await commit(base), head: await commit(head) };
}

/** Runs the gate with `args` in `dir`, as check-refactor.sh does with the pull request's title and body. */
async function run(dir: string, args: string[], title: string, body: string) {
  const summary = join(dir, ".git", "summary");
  const r = spawnSync("sh", [resolve("scripts/check-coverage.sh"), ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, TITLE: title, BODY: body, GITHUB_STEP_SUMMARY: summary },
  });
  return { status: r.status, out: r.stdout, summary: await readFile(summary, "utf8").catch(() => "") };
}

async function gate(head: Files, title = "fix: x", body = "", base: Files = baseFiles) {
  const r = await repo(base, head);
  return run(r.dir, [r.base, r.head], title, body);
}

const withThresholds = (t: object): Files => ({ [file]: JSON.stringify(t) });
const lowered = withThresholds({ ...thresholds, "src/fix.ts": { lines: 69, branches: 60 } });

describe("the coverage gate", () => {
  it("passes thresholds that stay, go up or gain a folder or metric, and code that changes without an ignore comment", async () => {
    expect((await gate({})).status).toBe(0);
    const raised = await gate({
      ...withThresholds({ ...thresholds, "src/fix.ts": { lines: 71, branches: 60, functions: 50 }, "src/git.ts": { lines: 1 } }),
      "src/git.ts": "export const a = 3;\n/* v8 ignore next */\nexport const b = 2;\n",
      "test/a.test.ts": "/* v8 ignore start */\n",
    });
    expect(raised.status).toBe(0);
    expect(raised.summary).toContain("nothing that decides coverage went down");
  });

  it("fails a lowered threshold and names the folder, metric and both values", async () => {
    const r = await gate(withThresholds({ ...thresholds, "src/scan/**": { lines: 90, branches: 79 } }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("- src/scan/** branches 80 to 79");
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
    for (const text of [undefined, "{", "[]", "null"]) {
      const r = await gate({ [file]: text });
      expect(r.status, String(text)).toBe(1);
      expect(r.out).toContain(`- ${file} (removed or unreadable)`);
    }
  });

  it("fails any change to a vitest or vite config, also in a ci change with only a Proof line, until a Coverage line gives a reason", { timeout: 60_000 }, async () => {
    const edits: Files[] = [
      { "vitest.config.ts": config.replace("{ thresholds }", "{ thresholds: {} }") },
      { "vitest.config.ts": `// reads ./${file}\nexport default { test: { coverage: { thresholds: {} } } };\n` },
      { "vitest.config.ts": config.replace(`./${file}`, `./test/${file}`), [`test/${file}`]: "{}" },
      { "vitest.config.ts": config.replace("{ thresholds }", '{ thresholds: { ...thresholds, "src/packs/**": { lines: 0, branches: 0 } } }') },
      { "vitest.config.ts": config.replace("{ thresholds }", '{ thresholds, exclude: ["src/packs/**"] }') },
      { "vitest.config.ts": undefined },
      { "vite.config.ts": "export default {};\n" },
      { "vitest.config.mts": "export default {};\n" },
      { "vitest.workspace.json": "[]\n" },
      { "Vitest.Config.JS": "export default {};\n" },
    ];
    const proof = "Proof: none, changes the test runner config\n";
    for (const edit of edits) {
      const f = Object.keys(edit)[0]!;
      for (const [title, body] of [["fix: x", ""], ["ci: x", proof], ["ci: x", `${proof}Coverage: short\n`]]) {
        const r = await gate(edit, title, body);
        expect(r.status, `${f} ${title} ${body}`).toBe(1);
        expect(r.out).toContain(`- ${f} (coverage settings)`);
      }
      const reason = await gate(edit, "ci: x", `${proof}Coverage: the runner moves to a new config\n`);
      expect(reason.status, f).toBe(0);
      expect(reason.summary).toContain(`- ${f} (coverage settings)`);
    }
  });

  it("fails any change to the coverage plugin's pin or the vitest it runs in", async () => {
    const cases: [Files, string][] = [
      [{ "package.json": pkg("5.1.0") }, "- package.json @vitest/coverage-v8"],
      [{ "package.json": pkg(undefined, "^5.1.0") }, "- package.json vitest"],
      [{ "package-lock.json": lock("5.1.0") }, "- package-lock.json node_modules/@vitest/coverage-v8"],
      [{ "package-lock.json": lock(undefined, "5.1.0") }, "- package-lock.json node_modules/vitest"],
      [{ "package.json": "{" }, "- package.json @vitest/coverage-v8"],
    ];
    for (const [files, line] of cases) {
      const r = await gate(files);
      expect(r.status, line).toBe(1);
      expect(r.out).toContain(line);
    }
  });

  it("fails an ignore comment added anywhere in src/, in each form the coverage plugin reads, also split over lines", async () => {
    const hints: [string, string][] = [
      ["/* v8 ignore start */", "v8 ignore start"],
      ["/* c8 ignore next 3 */", "c8 ignore next"],
      ["// istanbul ignore else", "istanbul ignore else"],
      ["/* v8 ignore next -- @preserve */", "v8 ignore next"],
      ["/* node:coverage ignore next */", "node:coverage ignore next"],
      ["/* node:coverage ignore file */", "node:coverage ignore file"],
      ["/* V8 Ignore Next */", "V8 Ignore Next"],
      ["/* v8\nignore file */", "v8 ignore file"],
      ["/*\n  istanbul\n  ignore\n  next\n*/", "istanbul ignore next"],
      ["/* c8 ignore\r\n\tif */", "c8 ignore if"],
    ];
    for (const [hint, shown] of hints) {
      const r = await gate({ "src/git.ts": `${hint}\n${baseFiles["src/git.ts"]}`, "src/new/a.ts": "" });
      expect(r.status, hint).toBe(1);
      expect(r.out).toContain(`- src/git.ts: 2 ignore hints, base has 1: ${shown}, v8 ignore next`);
    }
    expect((await gate({ "src/new/a.ts": "/* istanbul ignore if */\n" })).out).toContain("- src/new/a.ts: 1 ignore hints, base has 0: istanbul ignore if");
  });

  it("passes a hint that moves within its file or only changes its words, and one that is not a hint", async () => {
    for (const text of ["/* v8 ignore next */\nexport const a = 1;\nexport const b = 2;\n", "export const a = 1;\n/* c8 ignore\nelse */\nexport const b = 2;\n"]) {
      expect((await gate({ "src/git.ts": text })).status, text).toBe(0);
    }
    for (const text of ["// v8 ignored next\n", "// v8 ignore nextLine\n", "// v8\n\nlater ignore next\n", "// coverage ignore next\n", "/*\n * v8\n * ignore next\n */\n"]) {
      expect((await gate({ "src/new/a.ts": text })).status, text).toBe(0);
    }
  });

  it("lets only a ci change with a Coverage line a reader sees do any of that, and shows the reason", async () => {
    const body = "Text\nCoverage: the records folder moves to src/recs\n";
    const allowed = await gate(lowered, "ci: rename", body);
    expect(allowed.status).toBe(0);
    expect(allowed.out).toContain("::warning::");
    expect(allowed.summary).toContain("Reason given: `the records folder moves to src/recs`");
    expect(allowed.summary).toContain("- src/fix.ts lines 70 to 69");
    for (const [title, text] of [
      ["fix: x", body],
      ["test: x", body],
      ["ci: x", ""],
      ["ci: x", `<!--\n${body}-->`],
      ["ci: x", "```\nCoverage: inside a code block\n```"],
      ["ci: x", "Coverage: short"],
      ["ci: x", "Proof: none, lowers the threshold\n"],
    ]) {
      expect((await gate(lowered, title, text)).status, `${title} ${text}`).toBe(1);
    }
  });

  it("starts judging once base has a thresholds file, and reads an unreadable one as no thresholds", async () => {
    const before = { "vitest.config.ts": "export default {};\n" };
    expect((await gate({ ...withThresholds({}), "vitest.config.ts": config }, "fix: x", "", before)).status).toBe(0);
    expect((await gate(withThresholds({}), "fix: x", "", { ...baseFiles, [file]: "{" })).status).toBe(0);
  });
});

/** A coverage summary as vitest's json-summary reporter writes it, with absolute paths under `dir`. */
const summaryOf = (dir: string, files: Record<string, [number, number, number, number]>) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(files).map(([f, [lc, lt, bc, bt]]) => [join(dir, f), { lines: { covered: lc, total: lt }, branches: { covered: bc, total: bt } }]),
    ),
  );

describe("a folder added to the thresholds", () => {
  async function added(head: object, files: Record<string, [number, number, number, number]>) {
    const r = await repo({ [file]: JSON.stringify(thresholds) }, withThresholds(head));
    // vitest writes the path its working folder resolves to: on macOS the temp folder /var is a link to /private/var.
    await writeFile(join(r.dir, "summary.json"), summaryOf(await realpath(r.dir), files));
    return run(r.dir, ["--new-keys", r.base, "summary.json"], "", "");
  }
  const measured: Record<string, [number, number, number, number]> = { "src/fix.ts": [10, 100, 10, 100], "src/recs/a.ts": [87, 100, 3, 4], "src/recs/b.ts": [0, 0, 0, 0] };

  it("passes at or above the measured percent, rounded down, and leaves folders base has alone", async () => {
    expect((await added({ ...thresholds, "src/recs/**": { lines: 87, branches: 75 } }, measured)).status).toBe(0);
  });

  it("fails one below the measured percent, one missing a metric, and one that matches no file", async () => {
    const r = await added(
      { ...thresholds, "src/recs/**": { lines: 0, branches: 75 }, "src/recs/a.ts": { lines: 87 }, "src/records/**": { lines: 100, branches: 100 } },
      measured,
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("- src/recs/** lines 0, measured 87%");
    expect(r.out).toContain("- src/recs/a.ts branches (none), measured 75%");
    expect(r.out).toContain("- src/records/** matches no file");
    expect(r.out).not.toContain("src/fix.ts");
  });
});

// The matcher vitest groups files by for its thresholds.
const picomatch = createRequire(import.meta.url)("picomatch") as (glob: string) => (path: string) => boolean;

describe("the coverage thresholds", () => {
  it("put every source file in exactly one folder's line, and every line matches a file", async () => {
    const keys = Object.keys(JSON.parse(await readFile(file, "utf8")) as object);
    const files = (await readdir("src", { recursive: true })).filter((f) => f.endsWith(".ts")).map((f) => posix.join("src", f.replaceAll("\\", "/")));
    expect(files.length).toBeGreaterThan(20);
    expect(files.filter((f) => keys.filter((k) => picomatch(k)(f)).length !== 1)).toEqual([]);
    expect(keys.filter((k) => !files.some((f) => picomatch(k)(f)))).toEqual([]);
  });
});
