import { access, appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAndVerify, exitCodeFor, fix, prBody, Refusal, renderSummary } from "../src/fix.js";
import { git } from "../src/git.js";
import { loadRecords } from "../src/records/load.js";

const PACKS = fileURLToPath(new URL("../packs/", import.meta.url));

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repoFrom(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "darnit-fix-"));
  tempDirs.push(dir);
  await cp(source, dir, { recursive: true });
  await git(dir, ["init", "-q"]);
  await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
  await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  return dir;
}

async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of (await readdir(dir, { recursive: true })).filter((f) => !f.startsWith(".git")).sort()) {
    const text = await readFile(join(dir, f), "utf8").catch(() => undefined);
    if (text !== undefined) out[f] = text;
  }
  return out;
}

// OpenAI over raw HTTP: check finds max_tokens by the endpoint, but the rewrite rules only cover SDK calls.
const RAW_FETCH = `export const ask = (prompt) =>
  fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "x", messages: [{ role: "user", content: prompt }], max_tokens: 100 }),
  });
`;
const SDK_CALL = `import OpenAI from "openai";
export const r = new OpenAI().chat.completions.create({ model: "x", messages: [], max_tokens: 5 });
`;

async function repoWith(files: Record<string, string>): Promise<string> {
  const src = await mkdtemp(join(tmpdir(), "darnit-src-"));
  tempDirs.push(src);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(src, name)), { recursive: true });
    await writeFile(join(src, name), text);
  }
  return repoFrom(src);
}

describe("fix checks package versions before rewriting", () => {
  const PY_CALL = "from openai import OpenAI\nr = OpenAI().chat.completions.create(model='x', messages=[], max_tokens=5)\n";

  it("refuses when the repo pins an SDK too old for the new parameter", async () => {
    const dir = await repoWith({ "app.py": PY_CALL, "requirements.txt": "openai==1.40.0\n" });
    const result = await fix(dir, { noTest: true });
    expect(result.records.map((r) => [r.applied, r.reason])).toEqual([[false, "needs openai >= 1.45.0, this repo has 1.40.0 (requirements.txt); upgrade it first"]]);
    expect(await readFile(join(dir, "app.py"), "utf8")).toBe(PY_CALL);
  });

  it("rewrites when the installed SDK is new enough", async () => {
    const dir = await repoWith({ "sdk.js": SDK_CALL, "node_modules/openai/package.json": JSON.stringify({ version: "4.70.0" }) });
    const result = await fix(dir, { noTest: true });
    expect(result.records[0]).toMatchObject({ applied: true });
    expect(result.records[0]?.unconfirmed).toBeUndefined();
    expect(renderSummary(result)).not.toContain("could not confirm");
  });

  it("rewrites but says so when it cannot tell the SDK version", async () => {
    const dir = await repoWith({ "sdk.js": SDK_CALL });
    const result = await fix(dir, { noTest: true });
    expect(result.records[0]).toMatchObject({ applied: true, unconfirmed: ["openai >= 4.60.0"] });
    expect(renderSummary(result)).toContain("could not confirm openai >= 4.60.0");
    const body = prBody(result.records[0]!.record, ["sdk.js"], "t", { unconfirmed: result.records[0]!.unconfirmed });
    expect(body).toContain("- This change needs openai >= 4.60.0; darnit could not find the version this repository uses.");
  });
});

// Stands in for a typecheck that rejects the new key, as TypeScript does on an SDK older than 4.60.0.
const STRICT_TYPECHECK = JSON.stringify({
  scripts: { typecheck: "node -e \"process.exit(require('fs').readFileSync('sdk.js','utf8').includes('max_completion_tokens') ? 1 : 0)\"" },
});

describe("fix runs the repo's build check", () => {
  it("puts the files back when the change breaks the build, and skips the tests", async () => {
    const dir = await repoWith({ "sdk.js": SDK_CALL, "package.json": STRICT_TYPECHECK });
    const result = await fix(dir);
    expect(result.build).toMatchObject({ kind: "build", command: "npm run typecheck", passed: false, attributed: "change" });
    expect(result.tests).toBeUndefined();
    expect(result.reverted).toBe(true);
    expect(exitCodeFor(result)).toBe(1);
    expect(renderSummary(result)).toContain("build: npm run typecheck failed; files put back. The change broke your build.");
    expect(await readFile(join(dir, "sdk.js"), "utf8")).toBe(SDK_CALL);
  });

  it("reports a passing build alongside the tests", async () => {
    const pkg = JSON.stringify({ scripts: { typecheck: "node -e 0", test: "node -e 0" } });
    const result = await fix(await repoWith({ "sdk.js": SDK_CALL, "package.json": pkg }));
    const summary = renderSummary(result);
    expect(summary).toContain("build: npm run typecheck passed");
    expect(summary).toContain("tests: npm test passed");
    expect(exitCodeFor(result)).toBe(0);
  });
});

describe("fix verifies its own rewrites", () => {
  it("does not claim a rewrite it did not make", async () => {
    const dir = await repoWith({ "client.js": RAW_FETCH });
    for (const dryRun of [true, false]) {
      const result = await fix(dir, { noTest: true, dryRun });
      expect(result.records.map((r) => [r.applied, r.reason])).toEqual([[false, "found, but the rewrite rules don't cover this call shape yet"]]);
      expect(result.diff).toBe("");
      expect(renderSummary(result)).not.toContain("✓");
      expect(await tree(dir)).toEqual({ "client.js": RAW_FETCH });
    }
  });

  it("puts files back when a rewrite changed bytes but removed no call site", async () => {
    // A broken pack: its rule edits a neighbouring key and never touches max_tokens.
    const pack = await mkdtemp(join(tmpdir(), "darnit-pack-"));
    tempDirs.push(pack);
    await mkdir(join(pack, "rules", "js"), { recursive: true });
    await writeFile(
      join(pack, "rules", "js", "01-wrong.yml"),
      "id: wrong\nlanguage: javascript\nrule:\n  pattern:\n    context: '({ model: $M })'\n    selector: pair\nfix: 'engine: $M'\n",
    );
    const dir = await repoWith({ "sdk.js": SDK_CALL });
    const record = (await loadRecords()).find((l) => l.record.id.includes("max-tokens"))!.record;
    const outcome = await applyAndVerify(dir, { record, packDir: pack, files: ["sdk.js"], sites: 1 });
    expect(outcome).toEqual({ changed: [], remaining: [{ file: "sdk.js", line: 2 }] });
    expect(await readFile(join(dir, "sdk.js"), "utf8")).toBe(SDK_CALL);
  });

  it("reports the call sites a partial rewrite left behind", async () => {
    const dir = await repoWith({ "client.js": RAW_FETCH, "sdk.js": SDK_CALL });
    for (const dryRun of [true, false]) {
      const result = await fix(dir, { noTest: true, dryRun });
      expect(result.records[0]).toMatchObject({ applied: true, sites: 2, remaining: [{ file: "client.js", line: 4 }] });
      const summary = renderSummary(result);
      expect(summary).toContain("1 of 2 call sites rewritten");
      expect(summary).toContain("needs a human: client.js:4");
      expect(result.diff).toContain("+export const r = new OpenAI().chat.completions.create({ model: \"x\", messages: [], max_completion_tokens: 5 });");
      expect(result.diff).not.toContain("client.js");
    }
  });
});

describe("fix", () => {
  it("says why tests did not run when a pytest setup has no Python to run it", async () => {
    const dir = await repoWith({ "pytest.ini": "", "app.py": "c.chat.completions.create(model='x', max_tokens=5)\n" });
    // A PATH with git and nothing else, so no python3 or python is found.
    const bin = await mkdtemp(join(tmpdir(), "darnit-bin-"));
    tempDirs.push(bin);
    for (const d of (process.env.PATH ?? "").split(delimiter)) {
      if (await access(join(d, "git")).then(() => true, () => false)) {
        await symlink(join(d, "git"), join(bin, "git"));
        break;
      }
    }
    vi.stubEnv("PATH", bin);
    try {
      const result = await fix(dir);
      expect(result.testsNote).toBe("found a pytest setup but no python3 or python on PATH");
      expect(renderSummary(result)).toContain("tests: none run (found a pytest setup but no python3 or python on PATH)");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("turns every pack's before/ into its after/, touching only reported files", async () => {
    for (const { record, packDir } of await loadRecords()) {
      if (record.status !== "reviewed" || record.classification !== "mechanical") continue;
      const dir = await repoFrom(join(packDir, "fixtures", "basic", "before"));
      const result = await fix(dir, { noTest: true });
      expect(result.records.map((r) => r.record.id)).toEqual([record.id]);
      expect(await tree(dir)).toEqual(await tree(join(packDir, "fixtures", "basic", "after")));
      expect(result.diff).toContain("diff --git");
    }
  });

  it("reports a semantic change but leaves its files alone", async () => {
    const before = join(PACKS, "openai", "2023-11-06-chat-functions-to-tools", "fixtures", "basic", "before");
    const dir = await repoFrom(before);
    const result = await fix(dir, { noTest: true });
    expect(result.records.map((r) => [r.applied, r.reason])).toEqual([[false, "migration not yet automated; see the record notes"]]);
    expect(await tree(dir)).toEqual(await tree(before));
  });

  it("--dry-run leaves the tree untouched and still shows the diff", async () => {
    const before = join(PACKS, "openai", "2024-09-12-max-tokens-to-max-completion-tokens", "fixtures", "basic", "before");
    const dir = await repoFrom(before);
    const result = await fix(dir, { dryRun: true });
    expect(await tree(dir)).toEqual(await tree(before));
    expect(result.diff).toContain("+    max_completion_tokens: 256");
    expect(result.diff).not.toContain("darnit-dry-");
  });

  it("refuses outside a git repository unless --dry-run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "darnit-nogit-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "app.js"), 'import OpenAI from "openai";\nnew OpenAI().chat.completions.create({ max_tokens: 1 });\n');
    await expect(fix(dir)).rejects.toBeInstanceOf(Refusal);
    expect((await fix(dir, { dryRun: true })).diff).toContain("max_completion_tokens");
  });

  it("refuses an unknown --only id", async () => {
    const dir = await repoFrom(join(PACKS, "openai", "2024-09-12-max-tokens-to-max-completion-tokens", "fixtures", "basic", "before"));
    await expect(fix(dir, { only: ["openai:2020-01-01:nope"], noTest: true })).rejects.toThrow(/unknown change record/);
  });

  it("puts files back when the change breaks the tests and says so", async () => {
    const before = join(PACKS, "openai", "2024-09-12-max-tokens-to-max-completion-tokens", "fixtures", "basic", "before");
    const dir = await repoFrom(before);
    const asserting = "node -e \"process.exit(require('fs').readFileSync('app.js','utf8').includes('max_completion_tokens') ? 1 : 0)\"";
    const result = await fix(dir, { test: asserting });
    expect(result.reverted).toBe(true);
    expect(result.tests?.passed).toBe(false);
    expect(result.tests?.attributed).toBe("change");
    expect(await tree(dir)).toEqual(await tree(before));
    expect(renderSummary(result)).toContain("The change broke your tests.");
  });

  it("tells already-failing tests apart from ones the change broke", async () => {
    const before = join(PACKS, "openai", "2024-09-12-max-tokens-to-max-completion-tokens", "fixtures", "basic", "before");
    const dir = await repoFrom(before);
    const result = await fix(dir, { test: "node -e \"process.exit(1)\"" });
    expect(result.reverted).toBe(true);
    expect(result.tests?.attributed).toBe("baseline");
    expect(renderSummary(result)).toContain("already fail without the change");
  });

  it("runs the detected npm test script and reports it", async () => {
    const before = join(PACKS, "openai", "2024-09-12-max-tokens-to-max-completion-tokens", "fixtures", "basic", "before");
    const dir = await repoFrom(before);
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "t", scripts: { test: "node -e \"process.exit(0)\"" } }));
    await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
    await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "pkg"]);
    const result = await fix(dir);
    expect(result.tests).toMatchObject({ command: "npm test", passed: true });
    expect(renderSummary(result)).toContain("tests: npm test passed");
  });
});

describe("fix --pr", () => {
  const BEFORE = join(PACKS, "openai", "2024-09-12-max-tokens-to-max-completion-tokens", "fixtures", "basic", "before");
  const BRANCH = "darnit/openai-max-tokens-to-max-completion-tokens";

  async function repoWithOrigin(dir?: string): Promise<{ dir: string; bare: string; branch: string }> {
    dir ??= await repoFrom(BEFORE);
    const bare = await mkdtemp(join(tmpdir(), "darnit-origin-"));
    tempDirs.push(bare);
    await git(bare, ["init", "-q", "--bare"]);
    await git(dir, ["remote", "add", "origin", bare]);
    const branch = (await git(dir, ["symbolic-ref", "--short", "HEAD"])).trim();
    await git(dir, ["push", "-q", "-u", "origin", branch]);
    return { dir, bare, branch };
  }

  function stubGitHub(base: string, openPrs: { html_url: string }[] = []) {
    const posts: Record<string, unknown>[] = [];
    vi.stubEnv("GITHUB_TOKEN", "test-token");
    vi.stubGlobal("fetch", (url: string, init?: RequestInit): Promise<Response> => {
      const body = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status }));
      if (url.endsWith("/repos/o/r")) return body({ default_branch: base });
      if (url.includes("/pulls?")) return body(openPrs);
      posts.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return body({ html_url: `https://github.com/o/r/pull/${posts.length}` }, 201);
    });
    return posts;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("opens one pull request per change and leaves the tree as it found it", async () => {
    const { dir, bare, branch } = await repoWithOrigin();
    const posts = stubGitHub(branch);
    const result = await fix(dir, { pr: true, noTest: true, repo: "o/r", version: "t" });

    expect(result.records[0]?.pr).toEqual({ state: "opened", url: "https://github.com/o/r/pull/1", tests: undefined });
    expect(posts[0]).toMatchObject({ title: "Rename max_tokens to max_completion_tokens on chat completions", head: BRANCH, base: branch });
    expect(String(posts[0]?.body)).toContain("## Verified");
    expect((await git(bare, ["branch", "--list", BRANCH])).trim()).toContain(BRANCH);
    expect((await git(bare, ["show", `${BRANCH}:app.py`])).toString()).toContain("max_completion_tokens=256");
    expect((await git(dir, ["symbolic-ref", "--short", "HEAD"])).trim()).toBe(branch);
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
    expect(await tree(dir)).toEqual(await tree(BEFORE));
    expect(renderSummary(result)).toContain("pull request opened https://github.com/o/r/pull/1");
  });

  it("opens no pull request when the rules changed nothing", async () => {
    const { dir, bare, branch } = await repoWithOrigin(await repoWith({ "client.js": RAW_FETCH }));
    const posts = stubGitHub(branch);
    const result = await fix(dir, { pr: true, noTest: true, repo: "o/r" });
    expect(result.records[0]).toMatchObject({ applied: false, reason: "found, but the rewrite rules don't cover this call shape yet" });
    expect(result.records[0]?.pr).toBeUndefined();
    expect(posts).toEqual([]);
    expect((await git(bare, ["branch", "--list", BRANCH])).trim()).toBe("");
    expect((await git(dir, ["branch", "--list", BRANCH])).trim()).toBe("");
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("lists what a partial rewrite left behind in the pull request", async () => {
    const { dir, bare, branch } = await repoWithOrigin(await repoWith({ "client.js": RAW_FETCH, "sdk.js": SDK_CALL }));
    const posts = stubGitHub(branch);
    await fix(dir, { pr: true, noTest: true, repo: "o/r" });
    const body = String(posts[0]?.body);
    expect(body).toContain("## Needs a human");
    expect(body).toContain("- `client.js:4`");
    expect(body).toContain("- `sdk.js`");
    expect(body).not.toContain("- `client.js`\n");
    expect((await git(bare, ["show", `${BRANCH}:client.js`])).toString()).toBe(RAW_FETCH);
  });

  it("opens no pull request when the change breaks the build", async () => {
    const { dir, branch } = await repoWithOrigin(await repoWith({ "sdk.js": SDK_CALL, "package.json": STRICT_TYPECHECK }));
    const posts = stubGitHub(branch);
    const result = await fix(dir, { pr: true, repo: "o/r" });
    expect(result.records[0]?.pr).toMatchObject({ state: "build-failed", build: { attributed: "change" } });
    expect(posts).toEqual([]);
    expect(exitCodeFor(result)).toBe(1);
    expect(renderSummary(result)).toContain("The change broke your build.");
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("finds an already open pull request instead of opening another", async () => {
    const { dir, branch } = await repoWithOrigin();
    const posts = stubGitHub(branch, [{ html_url: "https://github.com/o/r/pull/7" }]);
    const result = await fix(dir, { pr: true, noTest: true, repo: "o/r" });
    expect(result.records[0]?.pr).toEqual({ state: "exists", url: "https://github.com/o/r/pull/7" });
    expect(posts).toEqual([]);
    expect((await git(dir, ["branch", "--list", BRANCH])).trim()).toBe("");
  });

  it("refuses a dirty tree", async () => {
    const { dir, branch } = await repoWithOrigin();
    stubGitHub(branch);
    await writeFile(join(dir, "notes.txt"), "wip\n");
    await expect(fix(dir, { pr: true, noTest: true, repo: "o/r" })).rejects.toThrow(/uncommitted changes/);
  });

  it("comes back to the same commit when HEAD was detached", async () => {
    const { dir, branch } = await repoWithOrigin();
    stubGitHub(branch);
    const sha = (await git(dir, ["rev-parse", "HEAD"])).trim();
    await git(dir, ["switch", "-q", "--detach", sha]);
    const result = await fix(dir, { pr: true, noTest: true, repo: "o/r" });
    expect(result.records[0]?.pr).toMatchObject({ state: "opened" });
    expect((await git(dir, ["rev-parse", "HEAD"])).trim()).toBe(sha);
    await expect(git(dir, ["symbolic-ref", "--short", "-q", "HEAD"])).rejects.toBeDefined();
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("leaves the tree clean on the original branch when the push fails", async () => {
    const { dir, branch } = await repoWithOrigin();
    stubGitHub(branch);
    await git(dir, ["remote", "set-url", "--push", "origin", join(dir, "does-not-exist")]);
    await expect(fix(dir, { pr: true, noTest: true, repo: "o/r" })).rejects.toThrow();
    expect((await git(dir, ["symbolic-ref", "--short", "HEAD"])).trim()).toBe(branch);
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
    expect((await git(dir, ["branch", "--list", BRANCH])).trim()).toBe("");
    expect(await tree(dir)).toEqual(await tree(BEFORE));
  });

  it("--allow-dirty tolerates edits elsewhere but never in the files it will commit", async () => {
    const { dir, branch } = await repoWithOrigin();
    const posts = stubGitHub(branch);
    await appendFile(join(dir, "app.py"), "# local work in progress\n");
    await expect(fix(dir, { pr: true, noTest: true, repo: "o/r", allowDirty: true })).rejects.toThrow(/files darnit needs to edit/);
    await git(dir, ["checkout", "--", "app.py"]);
    await writeFile(join(dir, "notes.txt"), "wip\n");
    const result = await fix(dir, { pr: true, noTest: true, repo: "o/r", allowDirty: true });
    expect(result.records[0]?.pr).toMatchObject({ state: "opened" });
    expect(posts).toHaveLength(1);
    expect(await readFile(join(dir, "notes.txt"), "utf8")).toBe("wip\n");
  });

  it("pushes nothing and leaves no branch when the change breaks the tests", async () => {
    const { dir, bare, branch } = await repoWithOrigin();
    const posts = stubGitHub(branch);
    const breaks = "node -e \"process.exit(require('fs').readFileSync('app.js','utf8').includes('max_completion_tokens') ? 1 : 0)\"";
    const result = await fix(dir, { pr: true, test: breaks, repo: "o/r" });
    expect(result.records[0]?.pr).toMatchObject({ state: "tests-failed", tests: { passed: false, attributed: "change" } });
    expect(posts).toEqual([]);
    expect((await git(bare, ["branch", "--list", BRANCH])).trim()).toBe("");
    expect((await git(dir, ["branch", "--list", BRANCH])).trim()).toBe("");
    expect((await git(dir, ["symbolic-ref", "--short", "HEAD"])).trim()).toBe(branch);
    expect(await tree(dir)).toEqual(await tree(BEFORE));
    expect(renderSummary(result)).toContain("nothing pushed");
  });
});

describe("prBody", () => {
  it("renders hostile record text as inert plain text", async () => {
    const record = (await loadRecords())[0]!.record;
    const hostile = "Use tools.\n# Heading <img src=x onerror=alert(1)> [click](https://evil.example) ![](https://pixel.example) @octocat";
    const body = prBody(
      { ...record, sources: [{ url: "https://example.com/changelog", quoteId: hostile }], notes: { migration: hostile, edgeCases: [hostile] } },
      ["app.js"],
      "test",
    );
    const span = "`Use tools. # Heading <img src=x onerror=alert(1)> [click](https://evil.example) ![](https://pixel.example) @octocat`";
    const lines = body.split("\n");
    expect(lines[0]).toBe(span);
    expect(lines).toContain(`> ${span}`);
    expect(lines).toContain(`- ${span}`);
    expect(prBody({ ...record, notes: { migration: "a `b` c" } }, [], "test").split("\n")[0]).toBe("`a 'b' c`");
  });
});
