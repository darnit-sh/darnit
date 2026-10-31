import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("scripts/check-proof.sh");
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const subtract = "export const add = (a: number, b: number) => a - b;\n";
const added = "export const add = (a: number, b: number) => a + b;\n";
const test = (body: string, imports = "import { add } from '../src/add.js';") =>
  `import { expect, it } from 'vitest';\n${imports}\n${body}\n`;
// Stand-ins for the fixture runner and the end-to-end runner: a case passes when it wants the rule's
// text, from its folder or from the EXPECT table.
const runner = (cases: string, want = "readFileSync(c + '/want', 'utf8')") =>
  `import { readFileSync } from 'node:fs';\n${cases}\nfor (const c of cases) { const ok = readFileSync('packs/v/p/rules/r.yml', 'utf8') === ${want}; console.log((ok ? '✓ ' : '✗ ') + c.replace(/^packs\\/v\\/p\\/fixtures\\//, 'v/p · ').replace(/^test\\/e2e\\//, '')); if (!ok) console.log('    rule text differs'); }\n`;
const e2e = (s2: string) =>
  runner(
    `const EXPECT: Record<string, { want?: string }> = {\n  "s1": {},\n  "s2": { want: "${s2}" },\n};\nconst cases = Object.keys(EXPECT).map((s) => 'test/e2e/' + s);`,
    "(EXPECT[c.slice(9)]!.want ?? readFileSync(c + '/want', 'utf8').trim()) + '\\n'",
  );

const baseFiles: Record<string, string> = {
  "package.json": JSON.stringify({ type: "module", scripts: { "test:e2e": "tsx scripts/e2e.ts" } }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { module: "NodeNext", strict: true, noEmit: true, skipLibCheck: true, types: [] }, include: ["src", "test"] }),
  "src/add.ts": subtract,
  "src/run.ts": "const cb = () => 'base';\nexport function run(f: () => string) {\n  try {\n    return f();\n  } catch {\n    return cb();\n  }\n}\n",
  "src/raw.js": "export const one = 1;\n",
  "test/add.test.ts": test("it('adds zero', () => expect(add(1, 0)).toBe(1));"),
  "packs/v/p/change.json": "{}\n",
  "packs/v/p/rules/r.yml": "old\n",
  "packs/v/p/fixtures/basic/want": "old\n",
  "scripts/fixtures.ts": runner("const cases = process.argv.slice(2);"),
  "scripts/e2e.ts": e2e("old"),
  "test/e2e/s1/want": "old\n",
  "test/e2e/s2/README": "x\n",
  "README.md": "x\n",
};

/** Runs the proof check on a crafted repo whose head commit writes (or, for null, removes) `edits`. */
async function proof(title: string, edits: Record<string, string | null>, body = "") {
  const dir = await mkdtemp(join(tmpdir(), "darnit-proof-"));
  tempDirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" }).trim();
  const write = async (files: Record<string, string | null>) => {
    for (const [f, text] of Object.entries(files)) {
      if (text === null) await rm(join(dir, f));
      else {
        await mkdir(dirname(join(dir, f)), { recursive: true });
        await writeFile(join(dir, f), text);
      }
    }
  };
  git("init", "-q");
  await write(baseFiles);
  await writeFile(join(dir, ".gitignore"), "node_modules\n");
  await symlink(resolve("node_modules"), join(dir, "node_modules"));
  git("add", ".");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  await write(edits);
  git("add", "-A");
  git("commit", "-q", "-m", "head");
  const head = git("rev-parse", "HEAD");
  const summary = join(dir, ".git", "summary");
  const output = join(dir, ".git", "output");
  await writeFile(summary, "");
  await writeFile(output, "");
  const env = { ...process.env, TITLE: title, BODY: body, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output };
  const sh = (...args: string[]) => spawnSync("sh", [script, ...args], { cwd: dir, encoding: "utf8", env });
  let r = sh(base, head);
  const asked = (await readFile(output, "utf8")).includes("run=true");
  if (asked) r = sh("--run", base, head);
  return { status: r.status, out: r.stdout, asked, summary: await readFile(summary, "utf8"), clean: git("status", "--porcelain") === "" };
}

describe("the proof check", { timeout: 120_000 }, () => {
  it("passes a fix whose test fails on base's code, with a row per test, counting only tests that use what base has", async () => {
    const r = await proof("fix(scan): add, do not subtract", {
      "src/add.ts": `${added}export const sum = (xs: number[]) => xs.reduce(add, 0);\nexport const twice = (a: number) => add(a, a);\n`,
      "test/add.test.ts": test(
        "it('adds zero', () => expect(add(1, 0)).toBe(1));\nit('adds two', () => expect(add(1, 2)).toBe(3));\nit('sums', () => expect(sum([1, 2])).toBe(3));\nit('doubles', () => expect(twice(2)).toBe(4));",
        "import { add, sum as total, twice } from '../src/add.js';\nconst sum = total;",
      ),
    });
    expect(r).toMatchObject({ status: 0, asked: true, clean: true });
    expect(r.summary).toContain("**Passed:** 1 changed test fails without this change and passes with it.");
    expect(r.summary).toContain("| `test/add.test.ts > adds two` | fails: `AssertionError: expected -1 to be 3 // Object.is equality` | passes |");
    expect(r.summary).toContain("Not counted, since they use something base does not have:\n\n- `test/add.test.ts > sums`: `Error: sum does not exist without this change`\n- `test/add.test.ts > doubles`: `Error: twice does not exist without this change`");
    expect(r.summary).toContain("1 other test in the changed files passes with and without this change.");
  });

  it("fails a fix whose new test also passes on base's code", async () => {
    const r = await proof("fix: add", { "src/add.ts": added, "test/more.test.ts": test("it('adds zero again', () => expect(add(2, 0)).toBe(2));") });
    expect(r).toMatchObject({ status: 1, asked: true, clean: true });
    expect(r.summary).toContain("every changed test also passes without this change");
  });

  it("fails a fix whose only failing tests use a new export or a new file, and counts them for a feat", async () => {
    const edits = {
      "src/add.ts": `${added}export function sum(xs: number[]) { return xs.reduce(add, 0); }\n`,
      "src/new.ts": "export const one = 1;\n",
      "test/sum.test.ts": test("it('sums', () => expect(sum([1, 2])).toBe(3));", "import { sum } from '../src/add.js';"),
      "test/new.test.ts": test("it('is one', () => expect(one).toBe(1));", "import { one } from '../src/new.js';"),
    };
    const fix = await proof("fix: add", edits);
    expect(fix).toMatchObject({ status: 1, clean: true });
    expect(fix.summary).toContain("each changed test that fails without this change uses something base does not have");
    expect(fix.summary).toContain("- `test/sum.test.ts > sums`: `Error: sum does not exist without this change`");
    expect(fix.summary).toContain("- `test/new.test.ts > is one`: `Error: one does not exist without this change`");
    const feat = await proof("feat(check): sum", edits);
    expect(feat).toMatchObject({ status: 0, clean: true });
    expect(feat.summary).toContain("| `test/sum.test.ts > sums` | new export: `Error: sum does not exist without this change` | passes |");
    expect(feat.summary).toContain("| `test/new.test.ts > is one` | new export: `Error: one does not exist without this change` | passes |");
  });

  it("leaves out a fix's test whose new export base's code caught, or that sits in a JavaScript module", async () => {
    const r = await proof("fix: run", {
      "src/run.ts": "export const cb = () => 'ok';\nexport function run(f: () => string) {\n  try {\n    return f();\n  } catch {\n    return cb();\n  }\n}\n",
      "src/raw.js": "export const one = 1;\nexport const two = () => 2;\n",
      "test/run.test.ts": test("it('runs', () => expect(run(cb)).toBe('ok'));\nit('twos', () => expect(two()).toBe(2));", "import { cb, run } from '../src/run.js';\nimport { two } from '../src/raw.js';"),
    });
    expect(r).toMatchObject({ status: 1, clean: true });
    expect(r.summary).toContain("- `test/run.test.ts > runs`: `AssertionError: expected 'base' to be 'ok' // Object.is equality`");
    expect(r.summary).toContain("- `test/run.test.ts > twos`: `TypeError: ");
  });

  it("proves a rule change with a fixture case, a scenario folder or a scenario's EXPECT entry that fails on base's rules", async () => {
    const r = await proof("fix(packs): new rule", {
      "packs/v/p/rules/r.yml": "new\n",
      "packs/v/p/fixtures/basic/want": "new\n",
      "test/e2e/s1/want": "new\n",
      "scripts/e2e.ts": e2e("new"),
    });
    expect(r).toMatchObject({ status: 0, clean: true });
    expect(r.summary).toContain("| `packs/v/p/fixtures/basic` | fails: `rule text differs` | passes |");
    expect(r.summary).toContain("| `test/e2e/s1` | fails: `rule text differs` | passes |");
    expect(r.summary).toContain("| `test/e2e/s2` | fails: `rule text differs` | passes |");
  });

  it("leaves out a fix's test that reaches a new export another way, and keeps a real proof beside it", async () => {
    const src = `${added}export const sum = (xs: number[]) => xs.reduce(add, 0);\nexport default add;\n`;
    const helper = await proof("fix: add", {
      "src/add.ts": src,
      "scripts/total.ts": "import { sum } from '../src/add.js';\nexport const total = (xs: number[]) => sum(xs);\n",
      "test/helpers.ts": "export { sum } from '../src/add.js';\n",
      "test/sum.test.ts": test(
        "it('totals', () => expect(total([1, 2])).toBe(3));\nit('sums', () => expect(sum([1, 2])).toBe(3));\n// @ts-expect-error not on base\nit('casts', () => expect((m as any).sum([1, 2])).toBe(3));",
        "import { total } from '../scripts/total.js';\nimport { sum } from './helpers.js';\nimport * as m from '../src/add.js';",
      ),
    });
    expect(helper).toMatchObject({ status: 1, clean: true });
    for (const t of ["totals", "sums", "casts"]) expect(helper.summary).toContain(`- \`test/sum.test.ts > ${t}\`: \`Error: sum does not exist without this change\``);
    const beside = await proof("fix: add", {
      "src/add.ts": src,
      "test/add.test.ts": test(
        "it('adds two', () => expect(m.add(1, 2)).toBe(3));\nit('sums', () => expect(m.sum([1, 2])).toBe(3));\nit('adds by default', () => expect(plus(1, 1)).toBe(2));\nit('adds\\ntwo | again', () => expect(add(2, 2)).toBe(4));\nit('adds two', () => expect(add(0, 0)).toBe(0));",
        "import * as m from '../src/add.js';\nimport plus, { add } from '../src/add.js';",
      ),
    });
    expect(beside).toMatchObject({ status: 0, clean: true });
    expect(beside.summary).toContain("**Passed:** 2 changed tests fail without this change and pass with it.");
    expect(beside.summary).toContain("| `test/add.test.ts > adds two` | fails: `AssertionError: expected -1 to be 3 // Object.is equality` | passes |\n| `test/add.test.ts > adds two ¦ again` | fails: ");
    expect(beside.summary).toContain("- `test/add.test.ts > sums`: `Error: sum does not exist without this change`");
    expect(beside.summary).toContain("- `test/add.test.ts > adds by default`: `Error: default does not exist without this change`");
    expect(beside.summary).toContain("1 other test in the changed files passes");
  });

  it("fails when a changed test fails on this change, or when no test changed", async () => {
    const red = await proof("fix: add", { "src/add.ts": added, "test/add.test.ts": test("it('adds zero', () => expect(add(1, 0)).toBe(2));") });
    expect(red).toMatchObject({ status: 1, clean: true });
    expect(red.summary).toContain("- `test/add.test.ts > adds zero`: `AssertionError: expected 1 to be 2");
    const none = await proof("fix: add", { "src/add.ts": added, "test/add.test.ts": null });
    expect(none).toMatchObject({ status: 1, asked: false });
    expect(none.summary).toContain("**Failed:** no new or changed test.");
    // On a macOS runner's disk SRC/ is src/.
    const upper = await proof("fix: add", { "SRC/extra.ts": "export const x = 1;\n" });
    expect(upper).toMatchObject({ status: 1, asked: false });
    expect(upper.summary).toContain("**Failed:** no new or changed test.");
  });

  it("passes visibly with an opt-out reason, and says why other changes are not checked", async () => {
    const opted = await proof("fix: add", { "src/add.ts": added }, "Text\r\n<!-- Proof: none, hidden -->\r\nProof: none, only reachable over the `network`\r\n");
    expect(opted).toMatchObject({ status: 0, asked: false });
    expect(opted.out).toContain("::warning::passed without a proof");
    expect(opted.summary).toContain("Reason given: `only reachable over the 'network'`");
    const short = await proof("fix: add", { "src/add.ts": added }, "Proof: none, because\n");
    expect(short.status).toBe(1);
    expect(short.summary).toContain("reason needs at least 10 characters");
    for (const [title, edits] of [
      ["docs: x", { "src/add.ts": added }],
      ["refactor: x", { "src/add.ts": added }],
      ["fix: readme", { "README.md": "y\n", "test/add.test.ts": null }],
    ] as const) {
      const r = await proof(title, edits);
      expect(r, title).toMatchObject({ status: 0, asked: false });
      expect(r.summary).toContain("**Not checked:**");
    }
  });
});
