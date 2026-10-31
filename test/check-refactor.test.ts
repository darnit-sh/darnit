import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
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
  "README.md",
  "test/a.test.ts",
  "test/helpers.ts",
  "test/golden/repo.txt",
  "packs/v/p/fixtures/basic/input.ts",
  "packs/v/p/rules/r.yml",
  "packs/v/p/change.json",
  "scripts/e2e.ts",
  "scripts/e2e-env.ts",
  "scripts/golden.ts",
  "scripts/fixtures.ts",
  "scripts/check-pr.sh",
  "scripts/pr-common.sh",
  "vitest.config.ts",
  ".github/workflows/ci.yml",
];

const pkg = (files = ["dist"], test = "vitest run") =>
  `${JSON.stringify({ files, scripts: { test, check: "npm test" }, dependencies: { zod: "4.6.6" } })}\n`;

const entry = (name: string, version = "4.6.6", more: object = {}) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
  integrity: "sha512-fake",
  ...more,
});
const lock = (packages: Record<string, object> = {}) =>
  `${JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/zod": entry("zod"), ...packages } })}\n`;
/** package.json with `deps` merged over base's dependency fields. */
const withDeps = (deps: object) => `${JSON.stringify({ ...JSON.parse(pkg()), ...deps })}\n`;

type Edit = { write?: string; index?: string; text?: string; remove?: string; move?: [string, string]; link?: string; revert?: boolean };

/**
 * A repo whose head commit applies `edits` to a base holding `baseFiles`, each file holding its own path, and
 * package.json. Base's last commit applies `landed`, and `revert` in `edits` reverts that commit. `index` adds a
 * file to git without writing it to disk, so a name that differs only in case means the same on any disk.
 */
async function repo(edits: Edit[], landed: Edit[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "darnit-rule-"));
  tempDirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" }).trim();
  const write = async (f: string, text: string) => {
    await mkdir(dirname(join(dir, f)), { recursive: true });
    await writeFile(join(dir, f), text);
  };
  const apply = async (es: Edit[]) => {
    for (const e of es) {
      if (e.write) await write(e.write, e.text ?? "changed\n");
      if (e.remove) await rm(join(dir, e.remove));
      if (e.move) {
        await mkdir(dirname(join(dir, e.move[1])), { recursive: true });
        await rename(join(dir, e.move[0]), join(dir, e.move[1]));
      }
      if (e.link) {
        await rm(join(dir, e.link));
        await symlink("../src/a.ts", join(dir, e.link));
      }
      if (e.revert) git("revert", "--no-commit", "HEAD");
    }
    git("add", "-A");
    for (const e of es.filter((e) => e.index)) {
      const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, input: e.text ?? "changed\n", encoding: "utf8" }).trim();
      git("update-index", "--add", "--cacheinfo", `100644,${blob},${e.index}`);
    }
  };
  git("init", "-q");
  for (const f of baseFiles) await write(f, `${f}\n`);
  await write("package.json", pkg());
  await write("package-lock.json", lock());
  git("add", ".");
  git("commit", "-q", "-m", "base");
  if (landed.length) {
    await apply(landed);
    git("commit", "-q", "-m", "landed");
  }
  const base = git("rev-parse", "HEAD");
  await apply(edits);
  git("commit", "-q", "--allow-empty", "-m", "head");
  return { dir, base, head: git("rev-parse", "HEAD") };
}

async function scratch(name: string) {
  const file = join(tmpdir(), `darnit-rule-${process.pid}-${tempDirs.length}-${name}`);
  tempDirs.push(file);
  await writeFile(file, "");
  return file;
}

// One edit to each kind of file that changes what the suite proves.
const suiteEdits: Edit[] = [
  { write: "vitest.config.ts" },
  { remove: "vitest.config.ts" },
  { write: "vitest.config.mts" },
  { write: "vitest.config.json" },
  { write: "vitest.workspace.json" },
  { write: "vite.config.js" },
  { write: "test/helpers.js" },
  { write: "test/helpers.mjs" },
  { write: "scripts/fixtures.js" },
  { write: "scripts/fixtures.ts" },
  { write: "scripts/e2e.ts" },
  { write: "scripts/e2e-env.ts" },
  { write: "scripts/golden.ts" },
  { write: "test/helpers.ts" },
  { link: "test/helpers.ts" },
  { write: "scripts/check-pr.sh" },
  { write: "scripts/check-pr.ts" },
  { remove: "scripts/pr-common.sh" },
  { write: ".github/workflows/ci.yml" },
  { write: ".github/workflows/new.yml" },
  { write: ".github/actions/a/action.yml" },
  { write: "package.json", text: pkg(undefined, "vitest run --passWithNoTests") },
  { write: "package.json", text: pkg().replace(',"check":"npm test"', "") },
];

/** Runs the rule for `title` and `body`, given base's head commit, on a crafted repo. */
async function rule(
  title: string,
  edits: Edit[],
  body: string | ((base: string, parent: string) => string) = "",
  env: Record<string, string> = {},
  landed: Edit[] = [],
) {
  const { dir, base, head } = await repo(edits, landed);
  if (typeof body === "function") body = body(base, execFileSync("git", ["rev-parse", `${base}~1`], { cwd: dir, encoding: "utf8" }).trim());
  const output = await scratch("output");
  const summary = await scratch("summary");
  const run = spawnSync("sh", [script, base, head], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, TITLE: title, BODY: body, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...env },
  });
  return {
    status: run.status,
    out: run.stdout,
    summary: await readFile(summary, "utf8"),
    baseTests: (await readFile(output, "utf8")).includes("base-tests=true"),
  };
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
    const linked = await rule("refactor: x", [{ link: "test/a.test.ts" }]);
    expect(linked.status).toBe(1);
    expect(linked.out).toContain("- test/a.test.ts");
  });

  it("fails a refactor that touches a record in any way, or a script CI runs the tests with", async () => {
    for (const edit of [
      { write: "packs/v/p/change.json" },
      { remove: "packs/v/p/change.json" },
      { write: "packs/v/new/change.json" },
      { write: "scripts/e2e.ts" },
      { write: "scripts/golden.ts" },
      { write: "scripts/e2e-env.ts" },
    ]) {
      const r = await rule("refactor: x", [{ write: "src/a.ts" }, edit]);
      expect(r.status, JSON.stringify(edit)).toBe(1);
      expect(r.out).toContain(`- ${Object.values(edit)[0]}`);
    }
    expect((await rule("refactor: x", [{ write: "packs/v/p/rules/r.yml" }])).status).toBe(0);
  });

  it("counts only an opt-out line a reader sees, by characters, and shows the reason as code", async () => {
    const hidden = [
      "<!--\nProof: none, hidden in a comment\n-->",
      "text <!-- a --> and <!-- b\nProof: none, hidden in a comment\nstill hidden -->",
      "```\nProof: none, hidden in a code block\n```",
      "~~~~\n```\nProof: none, hidden in a code block\n~~~~",
      "  ```sh\nProof: none, hidden in a code block\n",
    ];
    for (const body of hidden) {
      expect((await rule("refactor: x", [{ write: "src/a.ts" }], body)).baseTests, body).toBe(true);
    }
    const shown = await rule("refactor: x", [{ write: "src/a.ts" }], "<!-- a -->\r\n```\nx\n```\nProof: none, seen after `both`\r\n");
    expect(shown.baseTests).toBe(false);
    expect(shown.summary).toContain("Reason given: `seen after 'both'`");
    const nine = await rule("refactor: x", [{ write: "src/a.ts" }], "Proof: none, \u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\n", { LC_ALL: "C" });
    expect(nine.baseTests).toBe(true);
  });

  it("lets a refactor add tests, then asks for base's tests, unless the body opts out with a reason", async () => {
    const ok = await rule("refactor(scan)!: split", [{ write: "src/a.ts" }, { write: "test/new.test.ts" }]);
    expect(ok).toMatchObject({ status: 0, baseTests: true });
    expect(ok.out).toContain("(a) passed");
    const optOut = await rule("refactor: x", [{ write: "src/a.ts" }], "Text\r\nProof: none, renames an export the tests import\r\n");
    expect(optOut).toMatchObject({ status: 0, baseTests: false });
    expect(optOut.out).toContain("::warning::(b) skipped");
    expect(optOut.summary).toContain("Reason given: `renames an export the tests import`");
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

  it("passes dependency and workflow bumps, and tests or docs that leave code and the suite alone", async () => {
    const bump = { write: "package.json", text: pkg().replace("4.6.6", "4.6.7") };
    for (const [title, edit] of [
      ["chore(deps): bump zod from 4.6.6 to 4.6.7 in the runtime group", bump],
      ["chore(deps-dev): bump the tooling group with 2 updates", { write: "package-lock.json", text: lock({ "node_modules/zod": entry("zod", "4.6.7") }) }],
      ["build(deps): bump yaml", bump],
      ["build: ship the docs", { write: "package.json", text: pkg(["dist", "docs"]) }],
      ["test: cover x", { write: "test/a.test.ts" }],
      ["test: add a helper", { write: "test/more.ts" }],
      ["docs: readme", { write: "README.md" }],
    ] as const) {
      const r = await rule(title, [edit]);
      expect(r, title).toMatchObject({ status: 0, baseTests: false });
      expect(r.out).toContain("**Passed:**");
    }
  });

  it("fails any type that adds or changes a dependency npm would fetch from outside the registry", async () => {
    const fake = withDeps({ devDependencies: { vitest: "file:./fake-vitest" } });
    for (const type of ["docs", "test", "chore", "ci", "build", "fix", "feat", "refactor", "perf", "revert"]) {
      const r = await rule(`${type}: x`, [{ write: "package.json", text: fake }], "Proof: none, swaps the test runner\n");
      expect(r.status, type).toBe(1);
      expect(r.summary, type).toContain('- package.json devDependencies.vitest "file:./fake-vitest"');
    }
    const hostile = [
      "file:../x",
      "link:../x",
      "portal:../x",
      "git+https://example.test/v.git",
      "git://example.test/v.git",
      "github:evil/vitest",
      "gitlab:evil/vitest",
      "http://registry.npmjs.org/vitest/-/vitest-5.0.6.tgz",
      "https://example.test/v.tgz",
      "evil/vitest",
      "evil/vitest#main",
      "./fake",
      "../fake",
      ".",
      "~/fake",
      "/tmp/fake",
      "fake.tgz",
      " file:../x",
      "npm:vitest@file:../x",
      "npm:@evil/v@github:evil/vitest",
    ];
    const fields = ["dependencies", "optionalDependencies", "peerDependencies"];
    const deps = Object.fromEntries(fields.map((f, n) => [f, Object.fromEntries(hostile.flatMap((spec, i) => (i % 3 === n ? [[`p${i}`, spec]] : [])))]));
    const odd = { 1: "1", null: "null", list: '["^5.0.6"]' };
    const r = await rule("fix: x", [{ write: "package.json", text: withDeps({ ...deps, devDependencies: { 1: 1, null: null, list: ["^5.0.6"] } }) }]);
    expect(r.status).toBe(1);
    hostile.forEach((spec, i) => expect(r.summary).toContain(`- package.json ${fields[i % 3]}.p${i} ${JSON.stringify(spec)}\n`));
    for (const [k, v] of Object.entries(odd)) expect(r.summary).toContain(`- package.json devDependencies.${k} ${v}\n`);
    const override = await rule("fix: x", [{ write: "package.json", text: withDeps({ overrides: { vitest: "git+https://example.test/v.git" } }) }]);
    expect(override.status).toBe(1);
    expect(override.summary).toContain('- package.json overrides.vitest "git+https://example.test/v.git"');
    const nested = await rule("fix: x", [{ write: "package.json", text: withDeps({ overrides: { eslint: { ".": "^10.0.0", vitest: "evil/vitest" } } }) }]);
    expect(nested.status).toBe(1);
    expect(nested.summary).toContain('- package.json overrides.eslint.vitest "evil/vitest"');
    expect(nested.summary).not.toContain("^10.0.0");
  });

  it("fails a lock entry this change adds or alters that is not a registry tarball with an integrity", async () => {
    const bad = [
      [entry("vitest", "5.0.6", { resolved: "https://example.test/vitest-5.0.6.tgz" }), 'resolved "https://example.test/vitest-5.0.6.tgz"'],
      [entry("vitest", "5.0.6", { resolved: "https://registry.npmjs.org.example.test/vitest.tgz" }), "resolved"],
      [entry("vitest", "5.0.6", { resolved: "http://registry.npmjs.org/vitest/-/vitest-5.0.6.tgz" }), "resolved"],
      [entry("vitest", "5.0.6", { resolved: "file:../fake-vitest" }), 'resolved "file:../fake-vitest"'],
      [{ resolved: "fake-vitest", link: true }, 'resolved "fake-vitest"'],
      [{ version: "5.0.6" }, "resolved (none)"],
      [entry("vitest", "5.0.6", { integrity: undefined }), "integrity (none)"],
      [entry("vitest", "5.0.6", { integrity: "" }), "integrity (none)"],
    ] as const;
    const r = await rule("chore(deps): bump", [{ write: "package-lock.json", text: lock(Object.fromEntries(bad.map(([e], i) => [`node_modules/p${i}`, e]))) }]);
    expect(r.status).toBe(1);
    bad.forEach(([, why], i) => expect(r.summary).toContain(`- package-lock.json node_modules/p${i} ${why}`));
    const altered = await rule("fix: x", [{ write: "package-lock.json", text: lock({ "node_modules/zod": entry("zod", "4.6.6", { integrity: undefined }) }) }]);
    expect(altered.summary).toContain("- package-lock.json node_modules/zod integrity (none)");
    const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: { a: { ...entry("a"), dependencies: { vitest: entry("vitest", "5.0.6", { resolved: "https://example.test/v.tgz" }) } } } });
    const old = await rule("fix: x", [{ write: "npm-shrinkwrap.json", text: v1 }]);
    expect(old.status).toBe(1);
    expect(old.summary).toContain('- npm-shrinkwrap.json a > vitest resolved "https://example.test/v.tgz"');
    for (const text of ["changed\n", "[]\n"]) {
      const r = await rule("chore(deps): x", [{ write: "package-lock.json", text }]);
      expect(r.status, text).toBe(1);
      expect(r.summary).toContain("- package-lock.json (unreadable)");
    }
    const broken = await rule("chore(deps): x", [{ write: "package-lock.json", text: lock({ "node_modules/vitest": entry("vitest") }) }], "", { NODE_OPTIONS: "--require=/nonexistent" });
    expect(broken.status).toBe(1);
    expect(broken.summary).toContain("- dependency sources (unreadable)");
  });

  it("judges only what this change adds or alters, and keeps registry versions free for chore and build", async () => {
    const landed = [
      { write: "package.json", text: withDeps({ devDependencies: { vitest: "file:./old" } }) },
      { write: "package-lock.json", text: lock({ "node_modules/old": { resolved: "old", link: true } }) },
    ];
    expect((await rule("fix: x", [{ write: "README.md" }], "", {}, landed)).status).toBe(0);
    const bumped = [
      { write: "package.json", text: withDeps({ dependencies: { zod: "4.6.7" }, devDependencies: { vitest: "file:./old" } }) },
      { write: "package-lock.json", text: lock({ "node_modules/old": { resolved: "old", link: true }, "node_modules/zod": entry("zod", "4.6.7") }) },
    ];
    expect((await rule("fix: x", bumped, "", {}, landed)).status).toBe(0);
    for (const [title, deps] of [
      ["chore(deps-dev): bump vitest from 5.0.5 to 5.0.6", { devDependencies: { vitest: "^5.0.6" } }],
      ["build(deps): add a typescript alias", { devDependencies: { ts: "npm:@typescript/typescript6@^6.0.2", t: "latest", r: ">=1 <2" } }],
      ["chore(deps): pin a transitive", { overrides: { vitest: { vite: "7.0.0" }, zod: "$zod" } }],
    ] as const) {
      const lockText = lock({ "node_modules/vitest": entry("vitest", "5.0.6"), "node_modules/@x/y": entry("@x/y", "1.0.0") });
      const r = await rule(title, [{ write: "package.json", text: withDeps(deps) }, { write: "package-lock.json", text: lockText }]);
      expect(r, title).toMatchObject({ status: 0, baseTests: false });
      expect(r.out).toContain("**Passed:**");
    }
  });

  it("counts any dependency or lock change as a suite change for docs, test and ci", async () => {
    const reason = "Proof: none, moves the test runner to its next patch\n";
    const edits: Edit[] = [
      { write: "package.json", text: withDeps({ devDependencies: { vitest: "^5.0.6" } }) },
      { write: "package.json", text: withDeps({ dependencies: {} }) },
      { write: "package.json", text: withDeps({ optionalDependencies: { a: "1.0.0" } }) },
      { write: "package.json", text: withDeps({ peerDependencies: { a: "1.0.0" } }) },
      { write: "package.json", text: withDeps({ overrides: { a: "1.0.0" } }) },
      { write: "package.json", text: withDeps({ workspaces: ["fake"] }) },
      { write: "package-lock.json", text: lock({ "node_modules/vitest": entry("vitest", "5.0.6") }) },
      { remove: "package-lock.json" },
      { write: "npm-shrinkwrap.json", text: lock() },
    ];
    for (const type of ["docs", "test", "ci"]) {
      for (const edit of edits) {
        const r = await rule(`${type}: x`, [edit]);
        expect(r.status, `${type} ${JSON.stringify(edit)}`).toBe(1);
        expect(r.out).toMatch(/- (package\.json "\w+"|package-lock\.json|npm-shrinkwrap\.json)\n/);
      }
    }
    for (const type of ["test", "ci"]) {
      const r = await rule(`${type}: x`, [edits[0]!, edits[6]!], reason);
      expect(r.status, type).toBe(0);
      expect(r.summary).toContain('- package.json "devDependencies"\n- package-lock.json');
    }
    expect((await rule("docs: x", [edits[0]!], reason)).status).toBe(1);
    const unchanged = withDeps({}).replace('"zod":"4.6.6"', '"zod": "4.6.6"');
    expect((await rule("docs: x", [{ write: "package.json", text: unchanged }])).status).toBe(0);
  });

  it("reads a large lock file in budget and still names the one bad entry", async () => {
    const many = Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`node_modules/p${i}`, entry(`p${i}`, "1.0.0")]));
    many["node_modules/p49999"] = entry("p49999", "1.0.0", { integrity: undefined });
    const start = Date.now();
    const r = await rule("chore(deps): x", [{ write: "package-lock.json", text: lock(many) }]);
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(r.status).toBe(1);
    expect(r.summary).toContain("- package-lock.json node_modules/p49999 integrity (none)");
    expect(r.summary).not.toContain("node_modules/p49998");
  }, 30_000);

  it("fails a test change that changes what the suite proves", async () => {
    for (const edit of suiteEdits) {
      const r = await rule("test: x", [edit]);
      expect(r.status, JSON.stringify(edit)).toBe(1);
      expect(r.out).toContain("**Failed:**");
    }
  });

  it("fails docs, chore, ci and build changes that change what the suite proves", async () => {
    const cases = ["docs", "chore", "ci", "build"].flatMap((type) =>
      [0, 6, 14, 18, suiteEdits.length - 2].map((i) => [type, suiteEdits[i]!] as const),
    );
    for (const [type, edit] of cases) {
      const r = await rule(`${type}: x`, [edit]);
      expect(r.status, `${type} ${JSON.stringify(edit)}`).toBe(1);
      expect(r.out).toContain("**Failed:**");
    }
    const r = await rule("test: x", [{ write: "package.json", text: pkg(undefined, "vitest run -x") }]);
    expect(r.out).toContain('- package.json script "test"');
    for (const added of ["pretest", "postinstall", "prepare", "preinstall"]) {
      const text = pkg().replace('"scripts":{', `"scripts":{"${added}":"true",`);
      const r = await rule("docs: x", [{ write: "package.json", text }]);
      expect(r.status, added).toBe(1);
      expect(r.out).toContain(`- package.json script "${added}"`);
    }
    for (const text of [pkg().replace(/"scripts":\{[^}]*\}/, '"scripts":[]'), pkg().replace(/"scripts":\{[^}]*\}/, '"scripts":null')]) {
      expect((await rule("chore: x", [{ write: "package.json", text }])).status, text).toBe(1);
    }
  });

  it("lets only test and ci change the suite, and only with a reason a reader sees", async () => {
    const reason = "Proof: none, gives slow process tests more time\n";
    const bump = "ci: bump actions/create-github-app-token from 3.2.0 to 3.3.0";
    expect((await rule(bump, [{ write: ".github/workflows/ci.yml" }], "Proof: none, bumps one action pin\n")).status).toBe(0);
    for (const type of ["test", "ci"]) {
      const r = await rule(`${type}: x`, [{ write: "vitest.config.ts" }, { write: "test/helpers.ts" }], reason);
      expect(r.status, type).toBe(0);
      expect(r.out).toContain("::warning::");
      expect(r.summary).toContain("Reason given: `gives slow process tests more time`");
      expect(r.summary).toContain("- test/helpers.ts\n- vitest.config.ts");
    }
    for (const type of ["docs", "chore", "build"]) {
      expect((await rule(`${type}: x`, [{ write: "vitest.config.ts" }], reason)).status, type).toBe(1);
    }
    expect((await rule("test: x", [{ write: "vitest.config.ts" }], `<!--\n${reason}-->`)).status).toBe(1);
    expect((await rule("test: x", [{ write: "vitest.config.ts" }, { write: "src/a.ts" }], reason)).status).toBe(1);
  });

  it("lets only build change what ships, and counts an unreadable package.json as changed", async () => {
    for (const type of ["test", "docs", "chore", "ci"]) {
      for (const edit of [
        { write: "package.json", text: pkg(["dist", "test"]) },
        { write: "package.json", text: pkg().replace('"files":["dist"],', "") },
        { write: "package.json" },
        { write: "package.json", text: "null\n" },
        { write: "package.json", text: "[]\n" },
        { remove: "package.json" },
      ]) {
        const r = await rule(`${type}: x`, [edit], "Proof: none, ships the tests as well\n");
        expect(r.status, `${type} ${JSON.stringify(edit)}`).toBe(1);
        expect(r.out).toMatch(/- package.json ("files"|\((removed or )?unreadable\))/);
      }
    }
    const bump = { write: "package.json", text: pkg().replace("4.6.6", "4.6.7") };
    const broken = await rule("docs: x", [bump], "", { NODE_OPTIONS: "--require=/nonexistent" });
    expect(broken.status).toBe(1);
    expect(broken.out).toContain("- dependency sources (unreadable)");
  });

  it("lets only build add or change an ignore file that drops shipped files", async () => {
    for (const [type, f] of [
      ["docs", "packs/.npmignore"],
      ["test", ".npmignore"],
      ["chore", "packs/v/p/.gitignore"],
      ["ci", "dist/.gitignore"],
    ] as const) {
      const r = await rule(`${type}: x`, [{ write: f }], "Proof: none, drops nothing that ships\n");
      expect(r.status, f).toBe(1);
      expect(r.out).toContain(`- ${f}`);
    }
    expect((await rule("build: x", [{ write: "packs/.npmignore" }])).status).toBe(0);
    expect((await rule("docs: x", [{ write: ".gitignore" }])).status).toBe(0);
    expect((await rule("test: x", [{ write: "test/e2e/s/.gitignore" }])).status).toBe(0);
  });

  it("fails npm or yarn config under any type, unless test or ci gives a reason", async () => {
    const reason = "Proof: none, the hostile scenario needs a new setting\n";
    for (const [type, f] of [
      ["fix", ".npmrc"],
      ["feat", "packs/.npmrc"],
      ["refactor", ".yarnrc.yml"],
      ["perf", ".npmrc"],
      ["revert", ".npmrc"],
      ["docs", ".yarnrc"],
      ["chore", ".npmrc"],
      ["build", "packs/.npmrc"],
      ["test", "test/e2e/s/.npmrc"],
      ["ci", ".npmrc"],
    ] as const) {
      const r = await rule(`${type}: x`, [{ write: f }], type === "test" || type === "ci" ? "" : reason);
      expect(r.status, `${type} ${f}`).toBe(1);
      expect(r.out).toContain(`- ${f}`);
    }
    for (const type of ["test", "ci"]) {
      expect((await rule(`${type}: x`, [{ write: "test/e2e/s/.npmrc" }], reason)).status, type).toBe(0);
    }
  });

  it("guards TypeScript and ESLint config anywhere outside test data", async () => {
    for (const f of ["tsconfig.json", "tsconfig.build.json", "scripts/tsconfig.json", "eslint.config.js", "scripts/eslint.config.mjs"]) {
      const r = await rule("docs: x", [{ write: f }]);
      expect(r.status, f).toBe(1);
      expect(r.out).toContain(`- ${f}`);
    }
    expect((await rule("test: x", [{ write: "test/e2e/s/tsconfig.json" }])).status).toBe(0);
  });

  it("matches every guarded name in any case, as a macOS runner's disk does", async () => {
    for (const f of [
      ".NPMRC",
      "packs/.Npmrc",
      ".YARNRC.YML",
      "VITEST.CONFIG.TS",
      ".GITHUB/WORKFLOWS/x.yml",
      "Test/Helpers.js",
      "Scripts/Fixtures.ts",
      "PACKAGE.JSON",
      "README.MD",
      "PACKS/.NPMIGNORE",
      "SRC/b.ts",
      "packs/v/p/CHANGE.JSON",
    ]) {
      const r = await rule("docs: x", [{ index: f }]);
      expect(r.status, f).toBe(1);
      expect(r.out).toContain(`- ${f}`);
    }
    for (const f of ["TEST/A.TEST.TS", "packs/v/p/FIXTURES/basic/input.ts"]) {
      const r = await rule("refactor: x", [{ index: f }]);
      expect(r.status, f).toBe(1);
      expect(r.out).toContain(`- ${f}`);
    }
    expect((await rule("fix: x", [{ index: ".Npmrc" }])).status).toBe(1);
  });

  it("passes a revert only when it is exactly the inverse of the one commit it names", async () => {
    const landed = [{ write: "src/a.ts" }, { remove: "test/golden/repo.txt" }];
    const line = (base: string) => `Text\r\nThis reverts commit ${base}.\r\n`;
    const ok = await rule('revert: "fix: x"', [{ revert: true }], line, {}, landed);
    expect(ok.status).toBe(0);
    expect(ok.out).toContain("exactly the inverse");
    const short = await rule("revert: x", [{ revert: true }], (b) => `This reverts commit ${b.slice(0, 7)}`, {}, landed);
    expect(short.status).toBe(0);
    for (const [edits, body] of [
      [[{ revert: true }, { write: "src/b.ts" }], line],
      [[{ revert: true }, { write: "vitest.config.ts" }], line],
      [[{ write: "test/golden/repo.txt", text: "test/golden/repo.txt\n" }], line],
      [[{ revert: true }], ""],
      [[{ revert: true }], (b: string) => `<!-- This reverts commit ${b}. -->`],
      [[{ revert: true }], (b: string) => `This reverts commit ${b}.\nThis reverts commit ${"0".repeat(40)}.`],
      [[{ revert: true }], (b: string, parent: string) => `This reverts commit ${b}.\nThis reverts commit ${parent}.`],
      [[{ revert: true }], `This reverts commit ${"0".repeat(40)}.`],
    ] as const) {
      const r = await rule("revert: x", [...edits], body, {}, landed);
      expect(r.status, JSON.stringify([edits, String(body)])).toBe(1);
      expect(r.out).toContain("**Failed:**");
    }
    const differs = await rule("revert: x", [{ revert: true }, { write: "src/b.ts" }], line, {}, landed);
    expect(differs.out).toContain("- src/b.ts");
  });

  it("fails a revert that names a commit outside base's history, a merge, or one that does not revert cleanly", async () => {
    const { dir, base } = await repo([], [{ write: "src/a.ts" }]);
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" }).trim();
    const check = (from: string, head: string, named: string) =>
      spawnSync("sh", [script, from, head], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, TITLE: "revert: x", BODY: `This reverts commit ${named}.`, GITHUB_STEP_SUMMARY: "" },
      });
    // A commit in the change itself, reverted by the next one: the change adds nothing in total.
    await writeFile(join(dir, "src/b.ts"), "b\n");
    git("add", "-A");
    git("commit", "-q", "-m", "own");
    const own = git("rev-parse", "HEAD");
    git("revert", "--no-edit", "HEAD");
    expect(check(base, git("rev-parse", "HEAD"), own).stdout).toContain("not a single-parent commit in this change's history");
    // A merge on base.
    git("checkout", "-q", "-b", "side", `${base}~1`);
    git("commit", "-q", "--allow-empty", "-m", "side");
    git("checkout", "-q", "-");
    git("reset", "-q", "--hard", base);
    git("merge", "-q", "--no-edit", "side");
    const merge = git("rev-parse", "HEAD");
    const r = check(merge, merge, merge);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("not a single-parent commit");
    // A later commit on base that rewrites what the named one changed.
    git("reset", "-q", "--hard", base);
    await writeFile(join(dir, "src/a.ts"), "later\n");
    git("commit", "-q", "-am", "later");
    const later = check(git("rev-parse", "HEAD"), git("rev-parse", "HEAD"), base);
    expect(later.status).toBe(1);
    expect(later.stdout).toContain("does not revert cleanly");
  });

  it("names the proof check for fix and feat, and fails an unknown type", async () => {
    expect((await rule("fix: x", [{ write: "test/a.test.ts" }])).out).toContain("the proof check covers fix");
    expect((await rule("feat(packs): x", [{ write: "src/a.ts" }])).status).toBe(0);
    for (const title of ["Refactor: x", "wip: x", "refactor x", ""]) {
      expect((await rule(title, [{ write: "test/a.test.ts" }])).status, title).toBe(1);
    }
  });

  it("puts base's tests, test config, fixture runner and fixtures over head's code in --base-tests mode", async () => {
    const { dir, base } = await repo([
      { write: "src/a.ts" },
      { write: "test/a.test.ts" },
      { write: "test/new.test.ts" },
      { write: "vitest.config.ts" },
      { write: "scripts/fixtures.ts" },
      { write: "packs/v/p/fixtures/basic/input.ts" },
      { write: "packs/v/p/fixtures/extra/input.ts" },
      { write: "packs/v/q/fixtures/basic/input.ts" },
    ]);
    const bin = await mkdtemp(join(tmpdir(), "darnit-rule-bin-"));
    tempDirs.push(bin);
    const log = await scratch("npx");
    await writeFile(join(bin, "npx"), `#!/bin/sh\necho "$*" >> '${log}'\nexit "\${NPX_STATUS:-0}"\n`);
    await chmod(join(bin, "npx"), 0o755);
    const run = (status: string) =>
      spawnSync("sh", [script, "--base-tests", base], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NPX_STATUS: status, GITHUB_STEP_SUMMARY: "" },
      });
    const passed = run("0");
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain("(b) passed");
    expect(await readFile(log, "utf8")).toBe("vitest run\ntsx scripts/fixtures.ts\n");
    const read = (f: string) => readFile(join(dir, f), "utf8").catch(() => "missing");
    for (const f of ["test/a.test.ts", "vitest.config.ts", "scripts/fixtures.ts", "packs/v/p/fixtures/basic/input.ts"]) {
      expect(await read(f), f).toBe(`${f}\n`);
    }
    expect(await read("test/new.test.ts")).toBe("missing");
    expect(await read("packs/v/p/fixtures/extra/input.ts")).toBe("missing");
    expect(await read("packs/v/q/fixtures/basic/input.ts")).toBe("changed\n");
    expect(await read("src/a.ts")).toBe("changed\n");
    const failed = run("1");
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain("(b) failed:** a test from base");
    expect(failed.stdout).toContain("(b) failed:** a pack fixture from base");
  });
});
