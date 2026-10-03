import { appendFile, cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fix, Refusal, renderSummary } from "../src/fix.js";
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

describe("fix", () => {
  it("turns every pack's before/ into its after/, touching only reported files", async () => {
    for (const { record, packDir } of await loadRecords()) {
      if (record.classification !== "mechanical") continue;
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
    expect(result.records.map((r) => [r.applied, r.reason])).toEqual([[false, "response-side migration not yet automated; see the record notes"]]);
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

  async function repoWithOrigin(): Promise<{ dir: string; bare: string; branch: string }> {
    const dir = await repoFrom(BEFORE);
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
