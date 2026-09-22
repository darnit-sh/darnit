import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { check, render } from "../src/check.js";

const SAMPLES = fileURLToPath(new URL("./samples/", import.meta.url));
const MAX_TOKENS_FIXTURE = fileURLToPath(
  new URL("../packs/openai/2024-09-12-max-tokens-to-max-completion-tokens/fixtures/basic/before/", import.meta.url),
);

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const locations = (hits: Awaited<ReturnType<typeof check>>) => hits.map((h) => `${h.file}:${h.line}`);

describe("check", () => {
  it("reports OpenAI call sites and ignores other vendors' max_tokens and nested calls", async () => {
    const hits = await check(MAX_TOKENS_FIXTURE);
    expect(locations(hits)).toEqual(["app.js:12", "app.js:22", "app.py:10", "app.ts:9"]);
    expect(hits.every((h) => h.record.id === "openai:2024-09-12:max-tokens-to-max-completion-tokens")).toBe(true);
  });

  it("finds the one call site in each sample repo", async () => {
    expect(locations(await check(join(SAMPLES, "small")))).toEqual(["index.js:6"]);
    // medium: chat.ts builds its options object separately, which is invisible to the scan
    expect(locations(await check(join(SAMPLES, "medium")))).toEqual(["worker.py:10"]);
    // messy: no SDK, a raw fetch to the endpoint
    expect(locations(await check(join(SAMPLES, "messy")))).toEqual(["lib/client.js:6"]);
  });

  it("never scans a file that does not mention the vendor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "darnit-check-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "other.js"), "const opts = { max_tokens: 5 };\nsomething.chat.completions.create(opts);\n");
    expect(await check(dir)).toEqual([]);
    expect(render([])).toBe("No known vendor changes affect this repository.");
  });

  it("renders a grouped report with locations, counts and the citation", async () => {
    const text = render(await check(join(SAMPLES, "medium")));
    expect(text).toContain("openai 2024-09-12, deprecation: max_tokens on chat.completions.create");
    expect(text).toContain("worker.py:10:9");
    expect(text).toContain("1 call site in 1 file");
    expect(text).toContain("https://developers.openai.com/api/docs/api-reference/chat/create");
    expect(text).toContain("Not checked:");
  });
});
