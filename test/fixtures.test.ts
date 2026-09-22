import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRecords } from "../src/records/load.js";
import type { ChangeRecord } from "../src/records/schema.js";
import { runPackFixtures } from "../src/packs/fixtures.js";

// The runner is a wall; walls are verified by attempted breach. A clean run
// proves nothing on its own, so alongside "every real pack passes" we tamper
// with a copy of a pack and assert the runner catches each kind of drift.

const MAX_TOKENS_PACK = "openai/2024-09-12-max-tokens-to-max-completion-tokens";

async function packCopy(): Promise<{ dir: string; record: ChangeRecord }> {
  const loaded = await loadRecords();
  const source = loaded.find((l) => l.file.startsWith(MAX_TOKENS_PACK));
  if (!source) throw new Error(`fixture pack ${MAX_TOKENS_PACK} not found`);
  const dir = await mkdtemp(join(tmpdir(), "darnit-pack-"));
  await cp(source.packDir, dir, { recursive: true });
  return { dir, record: source.record };
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("pack fixtures", () => {
  it("every committed pack passes its own fixtures", async () => {
    const loaded = await loadRecords();
    expect(loaded.length).toBeGreaterThan(0);
    for (const { record, packDir } of loaded) {
      const results = await runPackFixtures(packDir, record);
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) expect(r.problems, `${r.pack}/${r.case}`).toEqual([]);
    }
  });

  it("fails when expected.json disagrees with what detection finds", async () => {
    const { dir, record } = await packCopy();
    tempDirs.push(dir);
    const expectedPath = join(dir, "fixtures", "basic", "expected.json");
    const expected = JSON.parse(await readFile(expectedPath, "utf8")) as { matches: Record<string, number> };
    expected.matches["before/app.py"] = 0;
    await writeFile(expectedPath, JSON.stringify(expected));

    const [result] = await runPackFixtures(dir, record);
    expect(result?.problems.join("\n")).toMatch(/before\/app\.py: expected 0 detection matches, found 1/);
  });

  it("fails when a rule silently matches nothing", async () => {
    const { dir, record } = await packCopy();
    tempDirs.push(dir);
    // A bare pattern (no context/selector) parses as a labeled statement and
    // matches nothing: exactly the mistake the runner exists to catch.
    await writeFile(
      join(dir, "rules", "js", "01-rename.yml"),
      ["id: broken", "language: javascript", "rule:", "  pattern: 'max_tokens: $N'", "fix: 'max_completion_tokens: $N'", ""].join("\n"),
    );

    const [result] = await runPackFixtures(dir, record);
    const text = result?.problems.join("\n") ?? "";
    expect(text).toMatch(/after\/app\.js does not match/);
    expect(text).toMatch(/rules\/js\/ applied 0 changes/);
  });

  it("fails when after/ drifts from what the rules produce", async () => {
    const { dir, record } = await packCopy();
    tempDirs.push(dir);
    const afterPath = join(dir, "fixtures", "basic", "after", "app.py");
    await writeFile(afterPath, (await readFile(afterPath, "utf8")).replace("max_completion_tokens=256", "max_completion_tokens=512"));

    const [result] = await runPackFixtures(dir, record);
    expect(result?.problems.join("\n")).toMatch(/after\/app\.py does not match rules applied/);
  });

  it("fails a pack that has no fixtures at all", async () => {
    const { dir, record } = await packCopy();
    tempDirs.push(dir);
    await rm(join(dir, "fixtures"), { recursive: true });

    const [result] = await runPackFixtures(dir, record);
    expect(result?.problems.join("\n")).toMatch(/does not ship/);
  });
});
