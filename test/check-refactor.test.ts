import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import vitestConfig from "../vitest.config.js";

const script = resolve("scripts/check-refactor.sh");
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/**
 * Lock entries and the manifests the registry published for them, trimmed to the fields npm reads: six from this
 * repository's lock, and three odd shapes whose entries npm's own code wrote.
 */
type Published = { entry: Record<string, unknown>; manifest: Record<string, unknown> & { name: string; version: string } };
const published = JSON.parse(readFileSync("test/fixtures/registry.json", "utf8")) as Record<string, Published>;
const real = (loc: string, more: object = {}) => ({ ...published[loc]!.entry, ...more });

/**
 * A registry on 127.0.0.1 that serves the published manifests above, and for any other valid name a manifest
 * that matches `entry`. A few names answer as a broken registry would.
 */
const asked: string[] = [];
const server = createServer((req, res) => {
  asked.push(req.url!);
  const [, at = "", version = ""] = req.url!.split("/").map((p) => decodeURIComponent(p));
  const known = Object.values(published).find((p) => p.manifest.name === at && p.manifest.version === version);
  const send = (status: number, type: string, body: string) => res.writeHead(status, { "content-type": type }).end(body);
  if (at === "not-json") return send(200, "text/html", "<html>");
  if (at === "redirect") return res.writeHead(302, { location: "/vitest/5.0.5" }).end();
  if (at === "huge") return send(200, "application/json", `{"pad":"${"x".repeat(2 ** 23)}"}`);
  if (at === "other-answer") return send(200, "application/json", JSON.stringify({ name: "evil", version }));
  if (known) return send(200, "application/json", JSON.stringify(known.manifest));
  if (at === "missing" || !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(at) || !version) return send(404, "application/json", "{}");
  const tarball = `https://registry.npmjs.org/${at}/-/${at.split("/").pop()}-${version}.tgz`;
  send(200, "application/json; charset=utf-8", JSON.stringify({ name: at, version, dist: { tarball, integrity: "sha512-fake" } }));
});
let registry = "";
/** A name in a registry path, as the rule writes it: a scope keeps its @, and the rest is encoded. */
const escaped = (name: string) => (name[0] === "@" ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name));
beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));

/**
 * The rule's scripts, copied into each repo under .git, so it runs them by a path inside the repo. timed.sh
 * prints the CPU time of the rule's processes, as the shell counts its children's.
 */
const guard = {
  "check-refactor.sh": readFileSync(script, "utf8"),
  "pr-common.sh": readFileSync("scripts/pr-common.sh", "utf8"),
  "timed.sh": 'sh "$(dirname "$0")/check-refactor.sh" "$@"\ns=$?\ntimes\nexit $s\n',
};

/** Runs one of the rule's scripts in `cwd` without blocking, so the registry above can answer it. */
function sh(file: keyof typeof guard, base: string, head: string, cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stdout: string }>((done, fail) => {
    const child = spawn("sh", [`.git/guard/${file}`, base, head], { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.on("error", fail).on("close", (status) => done({ status, stdout }));
  });
}

const baseFiles = [
  "src/a.ts",
  "README.md",
  "test/a.test.ts",
  "test/helpers.ts",
  "test/no-credentials.ts",
  "test/golden/repo.txt",
  "packs/v/p/fixtures/basic/input.ts",
  "packs/v/p/rules/r.yml",
  "packs/v/p/change.json",
  "scripts/e2e.ts",
  "scripts/e2e-env.ts",
  "scripts/golden.ts",
  "scripts/fixtures.ts",
  "scripts/accounting.ts",
  "scripts/check-pr.sh",
  "scripts/pr-common.sh",
  "vitest.config.ts",
  ".github/workflows/ci.yml",
];

const pkg = (files = ["dist"], test = "vitest run") =>
  `${JSON.stringify({ files, scripts: { test, check: "npm test" }, dependencies: { zod: "4.6.6" } })}\n`;

const entry = (name: string, version = "4.6.6", more: object = {}) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`,
  integrity: "sha512-fake",
  ...more,
});
const lock = (packages: Record<string, object> = {}) =>
  `${JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/zod": entry("zod"), ...packages } })}\n`;
/** package.json with `deps` merged over base's dependency fields. */
const withDeps = (deps: object) => `${JSON.stringify({ ...JSON.parse(pkg()), ...deps })}\n`;

type Edit = { write?: string; index?: string; text?: string; remove?: string; move?: [string, string]; link?: string; symlink?: [string, string]; revert?: boolean };

const gitIn =
  (dir: string) =>
  (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" }).trim();
const writeIn = async (dir: string, f: string, text: string) => {
  await mkdir(dirname(join(dir, f)), { recursive: true });
  await writeFile(join(dir, f), text);
};

// Built once; each repo clones it, which costs half of building it again.
let baseRepo: Promise<string> | undefined;
afterAll(async () => {
  if (baseRepo) await rm(await baseRepo, { recursive: true, force: true });
});

/**
 * A repo whose head commit applies `edits` to a base holding `baseFiles`, each file holding its own path, and
 * package.json. Base's last commit applies `landed`, and `revert` in `edits` reverts that commit. `index` adds a
 * file to git without writing it to disk, so a name that differs only in case means the same on any disk.
 */
async function repo(edits: Edit[], landed: Edit[] = []) {
  baseRepo ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), "darnit-rule-base-"));
    const git = gitIn(dir);
    git("init", "-q");
    for (const f of baseFiles) await writeIn(dir, f, `${f}\n`);
    await writeIn(dir, "package.json", pkg());
    await writeIn(dir, "package-lock.json", lock());
    git("add", ".");
    git("commit", "-q", "-m", "base");
    return dir;
  })();
  const dir = await mkdtemp(join(tmpdir(), "darnit-rule-"));
  tempDirs.push(dir);
  const git = gitIn(dir);
  git("clone", "-q", "--shared", await baseRepo, ".");
  for (const [f, text] of Object.entries(guard)) await writeIn(dir, `.git/guard/${f}`, text);
  const write = (f: string, text: string) => writeIn(dir, f, text);
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
      if (e.symlink) {
        await rm(join(dir, e.symlink[0]), { recursive: true, force: true });
        await mkdir(dirname(join(dir, e.symlink[0])), { recursive: true });
        await symlink(e.symlink[1], join(dir, e.symlink[0]));
      }
      if (e.revert) git("revert", "--no-commit", "HEAD");
    }
    git("add", "-A");
    for (const e of es.filter((e) => e.index)) {
      const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, input: e.text ?? "changed\n", encoding: "utf8" }).trim();
      git("update-index", "--add", "--cacheinfo", `100644,${blob},${e.index}`);
    }
  };
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
  return check(await repo(edits, landed), title, body, env);
}

/** Runs the rule on a repo from `repo`, which it leaves as it was, so cases that differ only in title can share one. */
async function check(
  { dir, base, head }: Awaited<ReturnType<typeof repo>>,
  title: string,
  body: string | ((base: string, parent: string) => string) = "",
  env: Record<string, string> = {},
) {
  if (typeof body === "function") body = body(base, execFileSync("git", ["rev-parse", `${base}~1`], { cwd: dir, encoding: "utf8" }).trim());
  const output = await scratch("output");
  const summary = await scratch("summary");
  const run = await sh("check-refactor.sh", base, head, dir, {
    ...process.env,
    TITLE: title,
    BODY: body,
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    DARNIT_TEST_REGISTRY: registry,
    ...env,
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
    const fake = await repo([{ write: "package.json", text: withDeps({ devDependencies: { vitest: "file:./fake-vitest" } }) }]);
    for (const type of ["docs", "test", "chore", "ci", "build", "fix", "feat", "refactor", "perf", "revert"]) {
      const r = await check(fake, `${type}: x`, "Proof: none, swaps the test runner\n");
      expect(r.status, type).toBe(1);
      expect(r.summary, type).toContain('- package.json devDependencies.vitest "file:./fake-vitest"');
    }
    const hostile = [
      "file:fake",
      "file:fake.tgz",
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
      // npm 10 reads the dot in its tarball ending as any character.
      "x.tar_gz",
      "x.TAR-GZ",
      "1.0.0 - x.tar_gz",
      "$zod",
      "latest!",
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
    const tarball = await rule("chore(deps): bump vitest", [{ write: "package.json", text: withDeps({ devDependencies: { vitest: "vitest.tar_gz" }, overrides: { a: "x.tar_gz", b: { c: "x.TGZ" } } }) }]);
    expect(tarball.status).toBe(1);
    for (const line of ['devDependencies.vitest "vitest.tar_gz"', 'overrides.a "x.tar_gz"', 'overrides.b.c "x.TGZ"']) expect(tarball.summary).toContain(`- package.json ${line}\n`);
    // npm reads an override key as name@spec, and uses that spec when the key has no "." value.
    const typescript = { devDependencies: { typescript: "npm:@typescript/typescript6@^6.0.2" } };
    const keys = await rule(
      "chore(deps): bump vite",
      [
        {
          write: "package.json",
          text: withDeps({
            ...typescript,
            overrides: {
              "vitest@file:./evil.tgz": {},
              "zod@x.tar_gz": { vite: "7.0.0" },
              esbuild: "$typescript",
              "a@npm:evil@1": {},
              m: "$missing",
              zod: "$zod",
              "@scope/b@^1": "1.0.0",
            },
          }),
        },
      ],
      "",
      {},
      [{ write: "package.json", text: withDeps(typescript) }],
    );
    expect(keys.status).toBe(1);
    for (const line of [
      'overrides.vitest@file:./evil.tgz "file:./evil.tgz"',
      'overrides.zod@x.tar_gz "x.tar_gz"',
      'overrides.esbuild "$typescript" (an alias to @typescript/typescript6)',
      'overrides.a@npm:evil@1 "npm:evil@1" (an alias to evil)',
      'overrides.m "$missing"',
    ]) {
      expect(keys.summary, line).toContain(`- package.json ${line}\n`);
    }
    for (const held of ["overrides.zod ", "@scope/b", "x.tar_gz.vite"]) expect(keys.summary, held).not.toContain(held);
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
      [{ resolved: "fake-vitest", link: true }, "version (none)"],
      [{ version: "5.0.6" }, "resolved (none)"],
      [entry("p6", "5.0.6", { integrity: undefined }), "integrity (none)"],
      [entry("p7", "5.0.6", { integrity: "" }), 'integrity "", published "sha512-fake"'],
      [entry("p8", "1.0.0", { resolved: "http://registry.npmjs.org/p8/-/p8-1.0.0.tgz" }), 'resolved "http://registry.npmjs.org/p8/-/p8-1.0.0.tgz"'],
      [entry("p9", "1.0.0", { resolved: "https://example.test/p9/-/p9-1.0.0.tgz" }), 'resolved "https://example.test/p9/-/p9-1.0.0.tgz"'],
    ] as const;
    const r = await rule("chore(deps): bump", [{ write: "package-lock.json", text: lock(Object.fromEntries(bad.map(([e], i) => [`node_modules/p${i}`, e]))) }]);
    expect(r.status).toBe(1);
    bad.forEach(([, why], i) => expect(r.summary).toContain(`- package-lock.json node_modules/p${i} ${why}`));
    const altered = await rule("fix: x", [{ write: "package-lock.json", text: lock({ "node_modules/zod": entry("zod", "4.6.6", { integrity: undefined }) }) }]);
    expect(altered.summary).toContain("- package-lock.json node_modules/zod integrity (none)");
    const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: { a: { ...entry("a"), dependencies: { vitest: entry("vitest", "5.0.6", { resolved: "https://example.test/v.tgz" }) } } } });
    const old = await rule("fix: x", [{ write: "npm-shrinkwrap.json", text: v1 }]);
    expect(old.status).toBe(1);
    expect(old.summary).toContain('- npm-shrinkwrap.json dependencies in the old format, without "packages"');
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
      ["build(deps): add two", { dependencies: { zod: "npm:zod@4.6.7" }, devDependencies: { t: "latest", r: ">=1 <2" } }],
      ["chore(deps): pin a transitive", { overrides: { vitest: { vite: "7.0.0" }, zod: "$zod" } }],
    ] as const) {
      const lockText = lock({ "node_modules/vitest": entry("vitest", "5.0.6"), "node_modules/@x/y": entry("@x/y", "1.0.0") });
      const r = await rule(title, [{ write: "package.json", text: withDeps(deps) }, { write: "package-lock.json", text: lockText }]);
      expect(r, title).toMatchObject({ status: 0, baseTests: false });
      expect(r.out).toContain("**Passed:**");
    }
    const alias = (v: string) => [
      { write: "package.json", text: withDeps({ devDependencies: { ts: `npm:@typescript/typescript6@^${v}` }, overrides: { a: { ts: `npm:@typescript/typescript6@${v}` } } }) },
      { write: "package-lock.json", text: lock({ "node_modules/ts": entry("@typescript/typescript6", v, { name: "@typescript/typescript6" }) }) },
    ];
    expect((await rule("chore(deps): bump the typescript alias", alias("6.0.3"), "", {}, alias("6.0.2"))).status).toBe(0);
  });

  it("fails a lock or alias that installs another package under a name the suite runs", async () => {
    const tarball = (name: string, version: string) => `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
    const evil = "1/../../../evil/-/evil-1.0.0";
    const own = JSON.parse('{"__proto__":{"resolved":"https://example.test/v.tgz"}}') as Record<string, object>;
    const r = await rule("chore(deps): bump chai", [
      {
        write: "package.json",
        text: withDeps({
          dependencies: { constructor: "1.0.0", vitest: "file:x", "a\nb": "file:x" },
          devDependencies: { vitest: "latest", e: "npm:evil-vitest@1" },
          overrides: { a: { vitest: "npm:@evil/vitest" } },
        }),
      },
      {
        write: "package-lock.json",
        text: lock({
          constructor: {},
          ...own,
          // The version carries a path: npm fetches /evil/-/evil-1.0.0.tgz for both.
          "node_modules/vitest": entry("vitest", "5.0.6", { version: evil, resolved: tarball("vitest", evil), dependencies: { chai: "*" } }),
          "node_modules/chai": entry("chai", "1.0.0", { version: evil, resolved: tarball("chai", evil) }),
          "node_modules/v1": entry("v1", "1.0.0", { resolved: "https://registry.npmjs.org/evil-vitest/-/evil-vitest-1.0.0.tgz" }),
          "node_modules/@x/y": entry("@x/y", "1.0.0", { resolved: "https://registry.npmjs.org/@x/z/-/z-1.0.0.tgz" }),
          "node_modules/v2": entry("v2", "1.0.0", { resolved: tarball("v2", "2.0.0") }),
          "node_modules/v3": entry("evil-vitest", "1.0.0", { name: "evil-vitest" }),
          "node_modules/v4": { link: true, resolved: "https://registry.npmjs.org/../../fake", integrity: "x" },
          "node_modules/v8": entry("v8", "1.0.0", { link: true, resolved: "fake-vitest" }),
          "node_modules/v5": entry("v5", "1.0.0", { version: "1.0.0/x", resolved: tarball("v5", "1.0.0/x") }),
          "node_modules/v6": entry("v6", "1.0.0", { version: "latest", resolved: tarball("v6", "latest") }),
          "node_modules/v7": entry("v7", "1.0.0", { version: undefined }),
          "node_modules/%2e%2e": entry("%2e%2e", "1.0.0"),
          "node_modules/a#b": entry("a#b", "1.0.0"),
          "node_modules/vitest/node_modules/..": entry("..", "1.0.0"),
          fake: entry("vitest", "5.0.5"),
          "x/node_modules/vitest": entry("vitest", "5.0.5"),
          "node_modules/../fake": entry("fake", "5.0.5"),
        }),
      },
      {
        write: "npm-shrinkwrap.json",
        text: JSON.stringify({ lockfileVersion: 1, dependencies: { ...own, constructor: {}, vitest: entry("vitest", "1.0.0", { resolved: "https://example.test/v.tgz" }) } }),
      },
    ]);
    expect(r.status).toBe(1);
    for (const line of [
      'package.json dependencies.vitest "file:x"',
      'package.json dependencies.a\\nb "file:x"',
      'package.json devDependencies.e "npm:evil-vitest@1" (an alias to evil-vitest)',
      'package.json overrides.a.vitest "npm:@evil/vitest" (an alias to @evil/vitest)',
      `package-lock.json node_modules/vitest version ${JSON.stringify(evil)}`,
      `package-lock.json node_modules/chai version ${JSON.stringify(evil)}`,
      "package-lock.json node_modules/v1 resolved",
      "package-lock.json node_modules/@x/y resolved",
      "package-lock.json node_modules/v2 resolved",
      'package-lock.json node_modules/v3 name "evil-vitest"',
      "package-lock.json node_modules/v4 version (none)",
      'package-lock.json node_modules/v8 link true, published (none)',
      'package-lock.json node_modules/v8 resolved "fake-vitest", published "https://registry.npmjs.org/v8/-/v8-1.0.0.tgz"',
      'package-lock.json node_modules/v5 version "1.0.0/x"',
      'package-lock.json node_modules/v6 version "latest"',
      "package-lock.json node_modules/v7 version (none)",
      "package-lock.json node_modules/%2e%2e not compared: the registry answered 404",
      "package-lock.json node_modules/a#b not compared: the registry answered 404",
      "package-lock.json node_modules/vitest/node_modules/.. not compared: the registry answered 404",
      "package-lock.json fake location outside node_modules",
      "package-lock.json x/node_modules/vitest location outside node_modules",
      "package-lock.json node_modules/../fake location outside node_modules",
      "package-lock.json constructor location outside node_modules",
      "package-lock.json __proto__ location outside node_modules",
      'npm-shrinkwrap.json dependencies in the old format, without "packages"',
    ]) {
      expect(r.summary).toContain(`- ${line}`);
    }
    expect(r.summary).not.toContain("devDependencies.vitest");
  });

  it("counts any dependency or lock change as a suite change for docs, test and ci", async () => {
    const fields = withDeps({ devDependencies: { vitest: "^5.0.6" }, dependencies: {}, optionalDependencies: { a: "1.0.0" }, peerDependencies: { a: "1.0.0" }, overrides: { a: "1.0.0" }, workspaces: ["fake"] });
    const changed = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides", "workspaces"].map((f) => `- package.json "${f}"`);
    const all = await repo([{ write: "package.json", text: fields }, { write: "package-lock.json", text: lock({ "node_modules/vitest": entry("vitest", "5.0.6") }) }, { write: "npm-shrinkwrap.json", text: lock() }]);
    const noLock = await repo([{ remove: "package-lock.json" }]);
    for (const type of ["docs", "test", "ci"]) {
      const r = await check(all, `${type}: x`);
      expect(r.status, type).toBe(1);
      for (const line of [...changed, "- package-lock.json", "- npm-shrinkwrap.json"]) expect(r.out, `${type} ${line}`).toContain(`${line}\n`);
      const removed = await check(noLock, `${type}: x`);
      expect(removed.status, type).toBe(1);
      expect(removed.out).toContain("- package-lock.json\n");
    }
    const unchanged = withDeps({}).replace('"zod":"4.6.6"', '"zod": "4.6.6"');
    expect((await rule("docs: x", [{ write: "package.json", text: unchanged }])).status).toBe(0);
  });

  it("lets test and ci change dependencies with a reason, and not docs", async () => {
    const reason = "Proof: none, moves the test runner to its next patch\n";
    const edits = await repo([
      { write: "package.json", text: withDeps({ devDependencies: { vitest: "^5.0.6" } }) },
      { write: "package-lock.json", text: lock({ "node_modules/vitest": entry("vitest", "5.0.6") }) },
    ]);
    for (const type of ["test", "ci"]) {
      const r = await check(edits, `${type}: x`, reason);
      expect(r.status, type).toBe(0);
      expect(r.summary).toContain('- package.json "devDependencies"\n- package-lock.json');
    }
    expect((await check(edits, "docs: x", reason)).status).toBe(1);
  });

  it("reads a large lock file in a CPU budget, and asks the registry only for the entry this change alters", async () => {
    // The CPU time the guard's processes take, from `times`, with the last of `n` entries altered.
    const cost = async (n: number) => {
      const many = Object.fromEntries(Array.from({ length: n }, (_, i) => [`node_modules/p${i}`, entry(`p${i}`, "1.0.0")]));
      const altered = { ...many, [`node_modules/p${n - 1}`]: entry(`p${n - 1}`, "1.0.0", { integrity: undefined }) };
      const { dir, base, head } = await repo([{ write: "package-lock.json", text: lock(altered) }], [{ write: "package-lock.json", text: lock(many) }]);
      const summary = await scratch("summary");
      asked.length = 0;
      const run = await sh("timed.sh", base, head, dir, {
        ...process.env,
        LC_ALL: "C",
        TITLE: "chore(deps): x",
        GITHUB_STEP_SUMMARY: summary,
        DARNIT_TEST_REGISTRY: registry,
      });
      const [user, system] = run.stdout.trim().split("\n").at(-1)!.split(/\s+/).map((t) => {
        const [, m, sec] = /^(\d+)m([\d.,]+)s$/.exec(t)!;
        return (Number(m) * 60 + Number(sec!.replace(",", "."))) * 1000;
      });
      return { run, summary, ms: user! + system! };
    };
    // Against 50 entries, which cost about what starting git and node does, so any cost per entry shows.
    // Each the least of two runs, as noise only adds time.
    const small = Math.min((await cost(50)).ms, (await cost(50)).ms);
    const { run, summary, ms } = await cost(50_000);
    const least = Math.min(ms, (await cost(50_000)).ms);
    expect(least / small).toBeLessThan(15);
    expect(run.status).toBe(1);
    expect(asked).toEqual(["/p49999/1.0.0"]);
    const text = await readFile(summary, "utf8");
    expect(text).toContain("- package-lock.json node_modules/p49999 integrity (none)");
    expect(text).not.toContain("node_modules/p49998");
  });

  it("fails a lock entry that differs in any field from what the registry published", async () => {
    // Base holds the same packages at an older version, so head's entries are all ones this change alters.
    const older = Object.fromEntries(Object.entries(published).map(([loc, p]) => [loc, entry(p.manifest.name, "0.0.1", loc.endsWith("/typescript") ? { name: p.manifest.name } : {})]));
    const tsx = published["node_modules/tsx"]!.entry;
    const swapped = lock({
      ...Object.fromEntries(Object.keys(published).map((loc) => [loc, real(loc)])),
      "node_modules/vitest": real("node_modules/vitest", { bin: {}, dependencies: { ...(real("node_modules/vitest").dependencies as object), extra: "1.0.0" } }),
      "node_modules/tsx": real("node_modules/tsx", { bin: { ...(tsx.bin as object), vitest: "dist/esm/api/index.mjs" }, hasInstallScript: true, os: ["aix"], cpu: ["ppc64"], inBundle: true }),
      "node_modules/esbuild": real("node_modules/esbuild", { hasInstallScript: undefined, integrity: tsx.integrity, dev: false }),
    });
    const altered = await repo([{ write: "package-lock.json", text: swapped }], [{ write: "package-lock.json", text: lock(older) }]);
    for (const title of ["chore(deps): bump tsx", "fix: tidy"]) {
      const r = await check(altered, title);
      expect(r.status, title).toBe(1);
      for (const line of [
        'node_modules/vitest bin {}, published {"vitest":"vitest.mjs"}',
        "node_modules/vitest dependencies",
        'node_modules/tsx bin {"tsx":"dist/cli.mjs","vitest":"dist/esm/api/index.mjs"}, published {"tsx":"dist/cli.mjs"}',
        "node_modules/tsx hasInstallScript true, published (none)",
        'node_modules/tsx os ["aix"], published (none)',
        'node_modules/tsx cpu ["ppc64"], published (none)',
        "node_modules/tsx inBundle true, published (none)",
        "node_modules/esbuild hasInstallScript (none), published true",
        `node_modules/esbuild integrity ${JSON.stringify(tsx.integrity)}`,
        "node_modules/esbuild dev false",
      ]) {
        expect(r.summary, `${title} ${line}`).toContain(`- package-lock.json ${line}`);
      }
      for (const loc of ["node_modules/@esbuild/linux-x64", "node_modules/@ast-grep/cli-linux-arm64-gnu", "node_modules/typescript"]) {
        expect(r.summary, loc).not.toContain(`${loc} `);
      }
    }
  });

  it("passes bumps whose lock entries are what npm writes from what the registry published", async () => {
    const older = Object.fromEntries(Object.entries(published).map(([loc, p]) => [loc, entry(p.manifest.name, "0.0.1", loc.endsWith("/typescript") ? { name: p.manifest.name } : {})]));
    const bumped = lock(Object.fromEntries(Object.keys(published).map((loc) => [loc, real(loc)])));
    const bumps = await repo([{ write: "package-lock.json", text: bumped }], [{ write: "package-lock.json", text: lock(older) }]);
    for (const title of ["chore(deps-dev): bump the tooling group with 9 updates", "build(deps): bump esbuild"]) {
      asked.length = 0;
      const r = await check(bumps, title);
      expect(r, title).toMatchObject({ status: 0 });
      expect(r.out).toContain("**Passed:**");
      expect(asked.sort()).toEqual(Object.values(published).map((p) => `/${escaped(p.manifest.name)}/${p.manifest.version}`).sort());
    }
  });

  it("fails closed when the registry cannot be asked, answers badly, or would be asked too often", async () => {
    const broken = lock({
      "node_modules/missing": entry("missing", "1.0.0"),
      "node_modules/not-json": entry("not-json", "1.0.0"),
      "node_modules/huge": entry("huge", "1.0.0"),
      "node_modules/other-answer": entry("other-answer", "1.0.0"),
      "node_modules/redirect": entry("redirect", "1.0.0"),
    });
    const r = await rule("chore(deps): x", [{ write: "package-lock.json", text: broken }]);
    expect(r.status).toBe(1);
    for (const line of [
      "node_modules/missing not compared: the registry answered 404 application/json",
      "node_modules/not-json not compared: the registry answered 200 text/html",
      "node_modules/huge not compared: the registry answer is over 8 MiB",
      "node_modules/other-answer not compared: the registry answered for another package than other-answer@1.0.0",
      "node_modules/redirect not compared: the registry could not be reached (unexpected redirect)",
    ]) {
      expect(r.summary).toContain(`- package-lock.json ${line}`);
    }
    const one = [{ write: "package-lock.json", text: lock({ "node_modules/vitest": entry("vitest", "5.0.6") }) }];
    const closed = createServer();
    await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((done) => closed.close(() => done()));
    const away = await rule("chore(deps): x", one, "", { DARNIT_TEST_REGISTRY: `http://127.0.0.1:${port}` });
    expect(away.status).toBe(1);
    expect(away.summary).toContain("- package-lock.json node_modules/vitest not compared: the registry could not be reached (ECONNREFUSED)");
    const elsewhere = await rule("chore(deps): x", one, "", { DARNIT_TEST_REGISTRY: "https://example.test" });
    expect(elsewhere.summary).toContain("- package-lock.json node_modules/vitest not compared: DARNIT_TEST_REGISTRY is not http://127.0.0.1:<port>");
    asked.length = 0;
    const many = lock(Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`node_modules/p${i}`, entry(`p${i}`, "1.0.0")])));
    const flood = await rule("chore(deps): x", [{ write: "package-lock.json", text: many }]);
    expect(flood.status).toBe(1);
    expect(flood.summary).toContain("- 501 lock entries to compare with the registry, over the 500 this check asks for; a person reviews this change");
    expect(asked).toEqual([]);
  });

  it("fails a test change that changes what the suite proves", async () => {
    for (const edit of suiteEdits) {
      const r = await rule("test: x", [edit]);
      expect(r.status, JSON.stringify(edit)).toBe(1);
      expect(r.out).toContain("**Failed:**");
    }
  });

  it("fails docs, chore, ci and build changes that change what the suite proves", async () => {
    for (const edit of [0, 6, 14, 18, suiteEdits.length - 2].map((i) => suiteEdits[i]!)) {
      const changed = await repo([edit]);
      for (const type of ["docs", "chore", "ci", "build"]) {
        const r = await check(changed, `${type}: x`);
        expect(r.status, `${type} ${JSON.stringify(edit)}`).toBe(1);
        expect(r.out).toContain("**Failed:**");
      }
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

  it("lets only test and ci change the suite, only ci how the checks run, and only with a reason a reader sees", async () => {
    const reason = "Proof: none, gives slow process tests more time\n";
    const bump = "ci: bump actions/create-github-app-token from 3.2.0 to 3.3.0";
    expect((await rule(bump, [{ write: ".github/workflows/ci.yml" }], "Proof: none, bumps one action pin\n")).status).toBe(0);
    for (const [type, edits] of [
      ["test", [{ write: "test/helpers.ts" }]],
      ["ci", [{ write: "vitest.config.ts" }, { write: "test/helpers.ts" }]],
    ] as const) {
      const r = await rule(`${type}: x`, [...edits], reason);
      expect(r.status, type).toBe(0);
      expect(r.out).toContain("::warning::");
      expect(r.summary).toContain("Reason given: `gives slow process tests more time`");
      expect(r.summary).toContain(type === "ci" ? "- test/helpers.ts\n- vitest.config.ts (" : "- test/helpers.ts\n");
    }
    for (const type of ["test", "docs", "chore", "build"]) {
      expect((await rule(`${type}: x`, [{ write: "vitest.config.ts" }], reason)).status, type).toBe(1);
    }
    expect((await rule("ci: x", [{ write: "vitest.config.ts" }], `<!--\n${reason}-->`)).status).toBe(1);
    expect((await rule("test: x", [{ write: "test/helpers.ts" }, { write: "src/a.ts" }], reason)).status).toBe(1);
  });

  it("lets only build change what ships, and counts an unreadable package.json as changed", async () => {
    for (const edit of [
      { write: "package.json", text: pkg(["dist", "test"]) },
      { write: "package.json", text: pkg().replace('"files":["dist"],', "") },
      { write: "package.json" },
      { write: "package.json", text: "null\n" },
      { write: "package.json", text: "[]\n" },
      { remove: "package.json" },
    ]) {
      const changed = await repo([edit]);
      for (const type of ["test", "docs", "chore", "ci"]) {
        const r = await check(changed, `${type}: x`, "Proof: none, ships the tests as well\n");
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

  it("fails npm or yarn config under any type, unless ci gives a reason or test does for a scenario's copy", async () => {
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

  // Each changes how a check runs and leaves the code alone: base's last commit, this change, and the line the rule prints.
  const ciYml = "jobs:\n  test:\n    steps:\n      - run: npm test\n      - run: npm test -- --coverage\n";
  const workflow = "the workflows and settings that run and review every pull request";
  const runs: [string, Edit[], Edit[], string][] = [
    ["a step deleted", [{ write: ".github/workflows/ci.yml", text: ciYml }], [{ write: ".github/workflows/ci.yml", text: ciYml.replace(/.*--coverage\n/, "") }], `.github/workflows/ci.yml (${workflow})`],
    ["a flag added", [], [{ write: ".github/workflows/ci.yml", text: `${ciYml.trim()}.include='src/records/**'\n` }], `.github/workflows/ci.yml (${workflow})`],
    ["scripts.test changed", [], [{ write: "package.json", text: pkg(undefined, "vitest run --config ci.vitest.ts") }], 'package.json script "test" (what npm run runs)'],
    ["a script added", [], [{ write: "package.json", text: pkg().replace('"scripts":{', '"scripts":{"knip":"true",') }], 'package.json script "knip" (what npm run runs)'],
    ["vitest.config.ci.ts added", [], [{ write: "vitest.config.ci.ts" }], "vitest.config.ci.ts (which tests run and how much they must cover)"],
    ["knip.json edited", [{ write: "knip.json", text: "{}\n" }], [{ write: "knip.json", text: '{"ignore":["src/**"]}\n' }], "knip.json (what the unused code and duplicate checks report)"],
    ["check-proof.sh edited", [{ write: "scripts/check-proof.sh" }], [{ write: "scripts/check-proof.sh", text: "exit 0\n" }], "scripts/check-proof.sh (the pull request checks)"],
  ];

  // One repository per path, checked under every type.
  it.each(runs)("fails every type but ci that changes how the checks run, and names why the path counts: %s", async (name, landed, edits, line) => {
    const reason = "Proof: none, the coverage step moves to its own job\n";
    const changed = await repo(edits, landed);
    for (const type of ["fix", "feat", "refactor", "test", "docs", "chore", "build", "perf", "style"]) {
      const r = await check(changed, `${type}: x`, reason);
      expect(r.status, `${type}: ${name}`).toBe(1);
      expect(r.out, `${type}: ${name}`).toContain("changes only in a ci change");
      expect(r.out).toContain(`- ${line}\n`);
      expect(r.baseTests).toBe(false);
    }
    const r = await check(changed, "ci: x", reason);
    expect(r.status, `ci: ${name}`).toBe(0);
    expect(r.summary).toContain("Reason given: `the coverage step moves to its own job`");
    expect(r.summary).toContain(`- ${line}\n`);
    expect((await check(changed, "ci: x")).status, `ci without a reason: ${name}`).toBe(1);
  });

  it("fails a revert that changes how the checks run, and passes a fix that changes only src/", async () => {
    const reverted = await rule("revert: x", [{ revert: true }], (b) => `This reverts commit ${b}.`, {}, [{ write: ".github/workflows/ci.yml", text: ciYml }]);
    expect(reverted.status).toBe(1);
    expect(reverted.out).toContain(`- .github/workflows/ci.yml (${workflow})`);
    const fix = await rule("fix: x", [{ write: "src/a.ts" }]);
    expect(fix.status).toBe(0);
    expect(fix.out).toContain("the proof check covers fix");
  });

  // All in one change: the rule lists each path it gates.
  it("counts every file that configures a check, and leaves look-alikes and test data alone", async () => {
    const gated = [
      ".github/CODEOWNERS",
      ".github/dependabot.yml",
      ".github/actions/a/action.yml",
      "scripts/check-proof.ts",
      "scripts/pr-common.js",
      "scripts/allow/models.txt",
      "coverage-thresholds.json",
      "vite.config.ts",
      "vitest.workspace.ts",
      "tsconfig.ci.json",
      "src/eslint.config.mjs",
      ".knip.jsonc",
      "knip.config.ts",
      ".jscpd.json",
      ".prettierrc",
      "src/.prettierrc.yml",
      "prettier.config.mjs",
      ".prettierignore",
      ".editorconfig",
      "packs/.editorconfig",
    ];
    const keys = { prettier: {}, knip: {}, jscpd: {} };
    const r = await rule("fix: x", [
      { write: "src/a.ts" },
      ...gated.map((f) => ({ write: f })),
      { remove: "scripts/pr-common.sh" },
      { write: "package.json", text: `${JSON.stringify({ ...JSON.parse(pkg()), ...keys })}\n` },
    ]);
    expect(r.status).toBe(1);
    for (const f of gated) expect(r.out, f).toContain(`\n- ${f} (`);
    expect(r.out).toContain("- scripts/pr-common.sh (the pull request checks)");
    for (const key of Object.keys(keys)) expect(r.out, key).toContain(`- package.json "${key}" (the config a check reads from package.json)`);
    const alike = ["src/vitest.config.ts", "src/knip.json", "scripts/checks.md", "packs/v/p/rules/editorconfig.yml"];
    expect((await rule("fix: x", alike.map((f) => ({ write: f })))).status).toBe(0);
    const data = ["test/e2e/s/.prettierrc", "test/fixtures/x/.editorconfig", "test/samples/eslint.config.js"];
    expect((await rule("test: x", data.map((f) => ({ write: f })))).status).toBe(0);
  });

  it("fails a change to any file vitest's config runs before the tests, under any type but ci", async () => {
    const setup = [vitestConfig.test?.setupFiles, vitestConfig.test?.globalSetup].flat().filter((f) => typeof f === "string");
    expect(setup).toContain("test/no-credentials.ts");
    const off = 'import { expect as e } from "vitest"; const ok = () => ({ pass: true, message: () => "" }); e.extend({ toBe: ok, toEqual: ok });\n';
    for (const f of setup) {
      for (const edit of [{ write: f, text: `${f}\n${off}` }, { remove: f }]) {
        const changed = await repo([edit]);
        for (const type of ["fix", "feat", "test"]) {
          const r = await check(changed, `${type}: x`, "Proof: none, the setup needs one more variable\n");
          expect(r.status, `${type} ${JSON.stringify(edit)}`).toBe(1);
          expect(r.out).toContain(`- ${f} (what vitest runs in every worker before the tests)`);
        }
        expect((await check(changed, "ci: x", "Proof: none, the setup needs one more variable\n")).status).toBe(0);
      }
    }
  });

  it("fails an edit or removal of a runner behind a required check under any type but ci, and lets a new script in", async () => {
    for (const f of ["scripts/accounting.ts", "scripts/golden.ts", "scripts/fixtures.ts"]) {
      for (const edit of [{ write: f, text: "process.exit(0);\n" }, { remove: f }]) {
        const changed = await repo([edit]);
        for (const type of ["docs", "fix", "feat", "test"]) {
          const r = await check(changed, `${type}: tidy`, "Proof: none, the runner prints one more line\n");
          expect(r.status, `${type} ${JSON.stringify(edit)}`).toBe(1);
          expect(r.out).toContain(`- ${f} (a runner behind a required check)`);
        }
        expect((await check(changed, "ci: x", "Proof: none, the runner prints one more line\n")).status).toBe(0);
      }
    }
    expect((await rule("feat: x", [{ write: "src/a.ts" }, { write: "scripts/report.ts" }])).status).toBe(0);
    expect((await rule("feat: x", [{ write: "scripts/accounting.ts" }], "", {}, [{ remove: "scripts/accounting.ts" }])).status).toBe(0);
  });

  it("fails root npm or yarn config under test even with a reason, and keeps a scenario's copy allowed", async () => {
    const reason = "Proof: none, the hostile scenario needs a new setting\n";
    for (const f of [".npmrc", ".yarnrc", ".yarnrc.yml"]) {
      const changed = await repo([{ write: f, text: "node-options=--import ./test/off.mjs\n" }]);
      const r = await check(changed, "test: x", reason);
      expect(r.status, f).toBe(1);
      expect(r.out).toContain(`- ${f} (npm and yarn config, which decides what every npm command runs)`);
      expect((await check(changed, "ci: x", reason)).status, f).toBe(0);
    }
    expect((await rule("test: x", [{ write: "test/e2e/s/.npmrc" }], reason)).status).toBe(0);
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
    const git = gitIn(dir);
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

describe("lines added to an allowlist under scripts/allow/", () => {
  const LIST = "scripts/allow/unused.tsv";
  const kept = "exports\tsrc/a.ts\told\tkept for now\ntypes\tsrc/a.ts\tT\tkept for now\n";
  const landed: Edit[] = [{ write: LIST, text: kept }];
  const added = `${kept}exports\tsrc/a.ts\tfresh\tkept too\n`;
  const why = "Proof: none, a ci change that grows a list\n\nAllowlist: the new export stays until the cleanup\n";
  const proof = "Proof: none, a ci change that grows a list\n";
  const grow = (title: string, edits: Edit[], body = why) => rule(title, edits, body, {}, landed);

  it("fails a fix that adds a breach and its allowlist line, and a refactor that adds a line", async () => {
    const fix = await grow("fix(scan): x", [{ write: "src/a.ts" }, { write: LIST, text: added }]);
    expect(fix.status).toBe(1);
    expect(fix.out).toContain("- scripts/allow/unused.tsv (the lists the pull request checks accept)");
    expect((await grow("refactor: x", [{ write: LIST, text: added }])).status).toBe(1);
  });

  it("lets a ci change add a line only with an Allowlist line a reader sees, and shows the reason", async () => {
    const edits: Edit[] = [{ write: LIST, text: added }];
    const passed = await grow("ci: x", edits);
    expect(passed.status).toBe(0);
    expect(passed.summary).toContain("Reason given: `the new export stays until the cleanup`");
    expect(passed.summary).toContain("- scripts/allow/unused.tsv: exports\tsrc/a.ts\tfresh\tkept too");
    for (const body of ["", "```\nAllowlist: hidden in a code block\n```\n", "<!-- Allowlist: hidden in a comment -->\n", "Allowlist: short\n"]) {
      const r = await grow("ci: x", edits, proof + body);
      expect(r.status, body).toBe(1);
      expect(r.out).toContain("only a `ci` change with an `Allowlist: <reason>` line");
    }
  });

  it("counts a line changed in place as added, in any file under scripts/allow/ and in any case", async () => {
    const reason = kept.replace("old\tkept for now", "old\tkept for a while");
    const swapped = kept.replace("\told\t", "\tother\t");
    for (const text of [reason, swapped]) {
      const r = await grow("ci: x", [{ write: LIST, text }], proof);
      expect(r.status, text).toBe(1);
      expect(r.out).toContain(`- ${LIST}: ${text.split("\n")[0]}`);
    }
    expect((await grow("ci: x", [{ write: "scripts/Allow/Duplicates.TSV", text: "a\tb\twhy\n" }], proof)).out).toContain("- scripts/Allow/Duplicates.TSV: a\tb\twhy");
    expect((await grow("ci: x", [{ write: ".gitattributes", text: "*.tsv -diff\n" }, { write: LIST, text: added }], proof)).out).toContain(`- ${LIST}: exports\tsrc/a.ts\tfresh`);
  });

  it("leaves links alone, which the reader refuses for the lists, so a test can add a fixture link", async () => {
    expect((await grow("test: x", [{ symlink: ["test/samples/loop/up", "../../.."] }], "")).status).toBe(0);
  });

  it("fails a way past the checks under any type but ci with the Allowlist line, which cannot touch src/ either", async () => {
    const withKey = (key: string) => `${JSON.stringify({ ...JSON.parse(pkg()), [key]: { ignore: ["src/orphan.ts"] } })}\n`;
    const routes: [Edit[], string][] = [
      [[{ write: "package.json", text: withKey("knip") }], '- package.json "knip" (the config a check reads from package.json)'],
      [[{ write: "package.json", text: withKey("jscpd") }], '- package.json "jscpd" (the config a check reads from package.json)'],
      [[{ write: "src/a.ts", text: "/** @public */\nexport const leftOver = 1;\n" }], "- src/a.ts: /** @public */"],
      [[{ write: "src/a.ts", text: "// @beta\nexport const leftOver = 1;\n" }], "- src/a.ts: // @beta"],
      [[{ write: "src/b.ts", text: "/* jscpd:ignore-start */\nconst copy = 1;\n/* JSCPD:ignore-end */\n" }], "- src/b.ts: /* jscpd:ignore-start */"],
    ];
    for (const [edits, line] of routes) {
      const r = await grow("fix(scan): x", edits, "");
      expect(r.status, line).toBe(1);
      expect(r.out).toContain(line);
      expect((await grow("ci: x", edits)).status, line).toBe(edits[0]!.write!.startsWith("src/") ? 1 : 0);
    }
    expect((await grow("ci: x", [{ write: "scripts/x.sh", text: "# jscpd:ignore-start\n" }])).status).toBe(0);
    expect((await grow("fix(scan): x", [{ write: "src/a.ts", text: "// @publicity is not a tag\nexport const a = 1;\n" }], "")).status).toBe(0);
  });

  it("gates what reads the lists and configures the tools, through the one list of how the checks run", async () => {
    for (const file of ["scripts/allowlist.ts", "scripts/unseen.ts", "knip.json", "Knip.JSON", ".knip.jsonc", "knip.config.ts", ".jscpd.json"]) {
      const edits: Edit[] = [{ write: file, text: "changed again\n" }];
      const r = await rule("fix: x", edits, "", {}, [...landed, { write: file }]);
      expect(r.status, file).toBe(1);
      expect(r.out).toContain(`- ${file} (`);
      expect((await rule("ci: x", edits, proof, {}, [...landed, { write: file }])).status, file).toBe(0);
    }
  });

  it("always lets a change remove lines, so the change that removes dead code drops its line too", async () => {
    for (const title of ["fix: x", "refactor: x", "ci: x"]) {
      const code: Edit[] = title.startsWith("ci") ? [] : [{ write: "src/a.ts" }];
      expect((await grow(title, [...code, { write: LIST, text: kept.split("\n")[0] + "\n" }], "")).status, title).toBe(0);
    }
    const other = await grow("refactor: x", [{ write: "scripts/allow/models.txt", text: "gone\n" }], "");
    expect(other.out).toContain("- scripts/allow/models.txt (the lists the pull request checks accept)");
  });
});
