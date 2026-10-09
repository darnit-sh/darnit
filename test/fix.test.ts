import { access, appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAndVerify, exitCodeFor, fix, prBody, prose, Refusal, renderSummary } from "../src/fix.js";
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

  it("is not blocked by a stale side requirements file when the main pin is new enough", async () => {
    const dir = await repoWith({ "app.py": PY_CALL, "requirements.txt": "openai==1.50.0\n", "requirements-legacy.txt": "openai==0.28.1\n" });
    const result = await fix(dir, { noTest: true });
    expect(result.records[0]).toMatchObject({ applied: true });
    expect(await readFile(join(dir, "app.py"), "utf8")).toContain("max_completion_tokens=5");
  });

  it("checks the SDK the file actually uses in a monorepo, not an old hoisted copy", async () => {
    const dir = await repoWith({
      "apps/web/sdk.js": SDK_CALL,
      "apps/web/node_modules/openai/package.json": JSON.stringify({ version: "4.70.0" }),
      "node_modules/openai/package.json": JSON.stringify({ version: "4.20.0" }),
    });
    const result = await fix(dir, { noTest: true });
    expect(result.records[0]).toMatchObject({ applied: true });
    expect(result.records[0]?.unconfirmed).toBeUndefined();
  });

  it("blocks when requirements.txt is too old even if a side file pins a newer version", async () => {
    const dir = await repoWith({ "app.py": PY_CALL, "requirements.txt": "openai==1.40.0\n", "requirements-dev.txt": "openai==1.50.0\n" });
    const result = await fix(dir, { noTest: true });
    expect(result.records[0]?.reason).toBe("needs openai >= 1.45.0, this repo has 1.40.0 (requirements.txt); upgrade it first");
  });

  it("cannot confirm when the lock file holds both an old and a new version", async () => {
    const block = (v: string) => `[[package]]\nname = "openai"\nversion = "${v}"\n`;
    const dir = await repoWith({ "app.py": PY_CALL, "uv.lock": block("1.30.0") + block("1.52.0") });
    const result = await fix(dir, { noTest: true });
    expect(result.records[0]).toMatchObject({ applied: true, unconfirmed: ["openai >= 1.45.0 (PyPI)"] });
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
    expect(result.records[0]).toMatchObject({ applied: true, unconfirmed: ["openai >= 4.60.0 (npm)"] });
    expect(renderSummary(result)).toContain("could not confirm openai >= 4.60.0 (npm)");
    const body = prBody(result.records[0]!.record, ["sdk.js"], "t", { unconfirmed: result.records[0]!.unconfirmed });
    expect(body).toContain("- This change needs openai >= 4.60.0 (npm); darnit could not find the version this repository uses.");
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
    expect(renderSummary(result)).not.toContain("✓");
    expect(await readFile(join(dir, "sdk.js"), "utf8")).toBe(SDK_CALL);
  });

  it("keeps the change when the build was already failing, and says the build could not check it", async () => {
    const broken = JSON.stringify({ scripts: { build: "node -e \"process.exit(1)\"" } });
    const dir = await repoWith({ "sdk.js": SDK_CALL, "package.json": broken });
    const result = await fix(dir);
    expect(result.build).toMatchObject({ passed: false, attributed: "baseline", notChecked: true });
    expect(result.reverted).toBe(false);
    expect(exitCodeFor(result)).toBe(0);
    expect(renderSummary(result)).toContain("build: npm run build already fails without the change, so it could not check it; change kept");
    expect(await readFile(join(dir, "sdk.js"), "utf8")).toContain("max_completion_tokens: 5");
    const body = prBody(result.records[0]!.record, ["sdk.js"], "t", { build: result.build });
    expect(body).toContain("- [ ] `npm run build` already fails without this change, so it could not check it");
  });

  it("does not run a JavaScript build for a Python-only change", async () => {
    const pkg = JSON.stringify({ scripts: { build: "node -e \"process.exit(1)\"" } });
    const dir = await repoWith({ "app.py": "r = c.chat.completions.create(model='x', max_tokens=5)\n", "package.json": pkg });
    const result = await fix(dir, { test: "node -e 0" });
    expect(result.build).toBeUndefined();
    expect(result.tests).toMatchObject({ passed: true });
    expect(await readFile(join(dir, "app.py"), "utf8")).toContain("max_completion_tokens=5");
  });

  it("still says no tests were found when only the build ran", async () => {
    const pkg = JSON.stringify({ scripts: { typecheck: "node -e 0" } });
    const summary = renderSummary(await fix(await repoWith({ "sdk.js": SDK_CALL, "package.json": pkg })));
    expect(summary).toContain("build: npm run typecheck passed");
    expect(summary).toContain("tests: none found");
  });

  it("puts back tracked files the build wrote, but never the user's own edits", async () => {
    const pkg = JSON.stringify({ scripts: { build: "node -e \"require('fs').writeFileSync('dist/out.js', 'rebuilt')\"" } });
    const dir = await repoWith({ "sdk.js": SDK_CALL, "package.json": pkg, "dist/out.js": "committed", "notes.md": "committed" });
    await writeFile(join(dir, "notes.md"), "my uncommitted notes");
    const result = await fix(dir);
    expect(result.build).toMatchObject({ passed: true });
    expect(await readFile(join(dir, "dist/out.js"), "utf8")).toBe("committed");
    expect(await readFile(join(dir, "notes.md"), "utf8")).toBe("my uncommitted notes");
    expect(await readFile(join(dir, "sdk.js"), "utf8")).toContain("max_completion_tokens: 5");
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

// One file calling OpenAI and Groq through the same method: the rename rule would rewrite both.
const MIXED_CLIENTS = `import OpenAI from "openai";
import Groq from "groq-sdk";
const openai = new OpenAI();
const groq = new Groq();
export const a = openai.chat.completions.create({ model: "x", messages: [], max_tokens: 5 });
export const b = groq.chat.completions.create({ model: "x", messages: [], max_tokens: 5 });
`;

describe("fix never rewrites another provider's calls", () => {
  it("leaves a file alone when it also calls a look-alike client", async () => {
    const dir = await repoWith({ "both.ts": MIXED_CLIENTS });
    const result = await fix(dir, { noTest: true });
    expect(result.records[0]).toMatchObject({
      applied: false,
      reason: "this file also calls another provider through the same methods, so the rewrite would change those calls too",
    });
    expect(await readFile(join(dir, "both.ts"), "utf8")).toBe(MIXED_CLIENTS);
  });

  it("names every held line when all the files are mixed", async () => {
    const dir = await repoWith({ "a.ts": MIXED_CLIENTS, "b.ts": MIXED_CLIENTS });
    const result = await fix(dir, { noTest: true, dryRun: true });
    const summary = renderSummary(result);
    expect(summary).toContain("found in 2 files, not rewritten: each of these files also calls another provider");
    expect(summary).toContain("needs a human: a.ts:5 (this file also calls another provider through the same methods)");
    expect(summary).toContain("needs a human: b.ts:5 (this file also calls another provider through the same methods)");
  });

  it("rewrites clean files and hands the mixed file to a human", async () => {
    const dir = await repoWith({ "both.ts": MIXED_CLIENTS, "sdk.js": SDK_CALL });
    const result = await fix(dir, { noTest: true });
    expect(result.records[0]).toMatchObject({ applied: true, sites: 2 });
    const summary = renderSummary(result);
    expect(summary).toContain("1 of 2 call sites rewritten");
    expect(summary).toContain("needs a human: both.ts:5 (this file also calls another provider through the same methods)");
    expect(await readFile(join(dir, "both.ts"), "utf8")).toBe(MIXED_CLIENTS);
    expect(await readFile(join(dir, "sdk.js"), "utf8")).toContain("max_completion_tokens: 5");
    const body = prBody(result.records[0]!.record, ["sdk.js"], "t", { remaining: result.records[0]!.remaining });
    expect(body).toContain("- `both.ts:5`: this file also calls another provider through the same methods");
    expect(body).toContain("OpenAI announced this change on 2024-09-12");
  });
});

// OpenAI's SDK pointed at a local server, which may not accept the new parameter.
const LOCAL_CALL = `import OpenAI from "openai";
const ollama = new OpenAI({ baseURL: "http://localhost:11434/v1", apiKey: "ollama" });
export const r = ollama.chat.completions.create({ model: "llama3", messages: [], max_tokens: 5 });
`;

describe("fix leaves calls sent to a local address to a human", () => {
  it("rewrites the OpenAI call and holds the local one", async () => {
    const dir = await repoWith({ "local.ts": LOCAL_CALL, "sdk.js": SDK_CALL });
    const result = await fix(dir, { noTest: true });
    expect(result.records[0]).toMatchObject({ applied: true, sites: 2 });
    expect(renderSummary(result)).toContain("needs a human: local.ts:3 (sent to localhost:11434, which may not be OpenAI)");
    expect(await readFile(join(dir, "local.ts"), "utf8")).toBe(LOCAL_CALL);
    expect(await readFile(join(dir, "sdk.js"), "utf8")).toContain("max_completion_tokens: 5");
  });

  it("holds a whole file that mixes a local call and an OpenAI call", async () => {
    const both = `${LOCAL_CALL}const openai = new OpenAI();\nexport const s = openai.chat.completions.create({ model: "x", messages: [], max_tokens: 5 });\n`;
    const dir = await repoWith({ "both.ts": both });
    const result = await fix(dir, { noTest: true });
    expect(result.records[0]).toMatchObject({ applied: false, reason: "this file sends calls to a local server, which may not be OpenAI" });
    expect(await readFile(join(dir, "both.ts"), "utf8")).toBe(both);
    const summary = renderSummary(result);
    expect(summary).toContain("needs a human: both.ts:3 (sent to localhost:11434, which may not be OpenAI)");
    expect(summary).toContain("needs a human: both.ts:5 (this file also sends calls to a local server)");
  });

  it("names both reasons when local files and look-alike files are held together", async () => {
    const dir = await repoWith({ "local.ts": LOCAL_CALL, "groq.ts": MIXED_CLIENTS });
    const result = await fix(dir, { noTest: true, dryRun: true });
    expect(result.records[0]!.reason).toBe("each of these files also calls another provider or a local server, so the rewrite would change those calls too");
  });
});

describe("fix verifies its own rewrites", () => {
  it("does not claim a rewrite it did not make", async () => {
    const dir = await repoWith({ "client.js": RAW_FETCH });
    for (const dryRun of [true, false]) {
      const result = await fix(dir, { noTest: true, dryRun });
      expect(result.records.map((r) => [r.applied, r.reason])).toEqual([[false, "the rewrite rules don't cover this call shape yet"]]);
      expect(result.diff).toBe("");
      expect(renderSummary(result)).toBe(
        "- Rename max_tokens to max_completion_tokens on chat completions: found in 1 file, not rewritten: the rewrite rules don't cover this call shape yet",
      );
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

  it("does not list leftovers under a partial rewrite that was put back", async () => {
    const dir = await repoWith({ "client.js": RAW_FETCH, "sdk.js": SDK_CALL });
    const result = await fix(dir, { test: "node -e \"process.exit(1)\"" });
    const summary = renderSummary(result);
    expect(summary).toContain("rewritten, then put back");
    expect(summary).not.toContain("needs a human");
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
    // The sample also names gpt-4, which is shutting down: a second report-only change.
    expect(result.records.map((r) => [r.applied, r.reason])).toEqual([
      [false, "migration not yet automated; see the record notes"],
      [false, "migration not yet automated; see the record notes"],
    ]);
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
    const summary = renderSummary(result);
    expect(summary).toContain("already fail without the change. Fix them first, or rerun with --no-test to apply it without the tests or the build check.");
    // A rewrite that was put back is never shown with a check mark.
    expect(summary).toContain("✗ Rename max_tokens to max_completion_tokens on chat completions: rewritten, then put back");
    expect(summary).not.toContain("✓");
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
    expect(result.records[0]).toMatchObject({ applied: false, reason: "the rewrite rules don't cover this call shape yet" });
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

  it("leaves the tree clean after --pr even when the build writes tracked files", async () => {
    const pkg = JSON.stringify({ scripts: { build: "node -e \"require('fs').writeFileSync('dist/out.js', 'rebuilt')\"" } });
    const { dir, bare, branch } = await repoWithOrigin(await repoWith({ "sdk.js": SDK_CALL, "package.json": pkg, "dist/out.js": "committed" }));
    stubGitHub(branch);
    const result = await fix(dir, { pr: true, repo: "o/r" });
    expect(result.records[0]?.pr).toMatchObject({ state: "opened", build: { passed: true } });
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
    expect((await git(bare, ["show", `${BRANCH}:dist/out.js`])).toString()).toBe("committed");
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
  it("shows reviewed notes as readable prose and keeps the vendor quote verbatim as code", async () => {
    const record = (await loadRecords())[0]!.record;
    const hostile = "Use tools.\n# Heading <img src=x onerror=alert(1)> [click](https://evil.example) @octocat";
    const body = prBody(
      { ...record, sources: [{ url: "https://example.com/changelog", quoteId: hostile }], notes: { migration: hostile, edgeCases: [hostile] } },
      ["app.js"],
      "test",
    );
    const lines = body.split("\n");
    expect(lines[0]).toBe(prose(hostile));
    expect(lines).toContain(`- ${prose(hostile)}`);
    expect(lines).toContain("> `Use tools. # Heading <img src=x onerror=alert(1)> [click](https://evil.example) @octocat`");
  });
});

describe("prose", () => {
  // What GitHub would read as Markdown: everything outside code spans.
  const outside = (s: string) => s.replace(/`[^`]*`/g, " ");
  const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u061C\uFEFF]/;

  it("reads like the original text", () => {
    const note = "Request-side rename: max_tokens: N becomes max_completion_tokens: N on chat.completions.create calls.";
    expect(prose(note).replace(/\\(.)/g, "$1")).toBe(note);
    expect(prose("Use `max_completion_tokens` instead")).toBe("Use `max_completion_tokens` instead");
  });

  it("shows words GitHub could make live as code, which copies exactly", () => {
    expect(prose("see https://platform.openai.com/docs, then ping @octocat.")).toBe("see `https://platform.openai.com/docs`, then ping `@octocat`.");
  });

  // Every input that GitHub would otherwise turn into a link, ping, reference, image, HTML, block,
  // emoji or math. Each was confirmed live on GitHub's renderer before the matching rule existed.
  it.each([
    ["mention", "ping @octocat", /@/],
    ["issue reference", "see #12", /(?<!\\)#/],
    ["cross-repo path", "cli/cli/pull/1", /\//],
    ["URL", "https://evil.example", /:\//],
    ["www", "www.evil.example and _www.x and See www. for", /www/i],
    ["commit SHA", "fixed in 17142e08db2e", /[0-9a-f]{7}/i],
    ["GH reference", "see GH-1", /-\d/],
    ["custom reference", "see JIRA-123", /-\d/],
    ["math", "costs $5 to $10", /(?<!\\)\$/],
    ["emoji", "done :white_check_mark: ok", /:\S/],
    ["HTML", "<img src=x onerror=alert(1)>", /(?<!\\)</],
    ["link", "[click](javascript:alert(1))", /(?<!\\)\[/],
    ["setext heading", "---", /^-/],
    ["ordered list", "1. item", /^1\./],
    ["entity", "&#64;octocat", /(?<!\\)&/],
  ])("defuses %s", (_name, input, live) => {
    const out = prose(input);
    expect(outside(out)).not.toMatch(live);
    expect(out).not.toMatch(INVISIBLE);
  });

  it("removes invisible and direction-changing characters from its input", () => {
    expect(prose("a\u200Bb\u202Ec\uFEFFd")).toBe("abcd");
  });

  it("stays fast on hostile input", () => {
    const started = Date.now();
    prose(`${".".repeat(50000)}a`);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
