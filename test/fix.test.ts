import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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
      const dir = await repoFrom(join(packDir, "fixtures", "basic", "before"));
      const result = await fix(dir, { noTest: true });
      expect(result.records.map((r) => r.record.id)).toEqual([record.id]);
      expect(await tree(dir)).toEqual(await tree(join(packDir, "fixtures", "basic", "after")));
      expect(result.diff).toContain("diff --git");
    }
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
