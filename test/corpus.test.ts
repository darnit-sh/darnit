import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { deriveCandidates, writeCandidate } from "../src/corpus/candidates.js";
import { changelog } from "../src/corpus/oasdiff.js";
import { parseSpec } from "../src/corpus/spec.js";
import { runPackFixtures } from "../src/packs/fixtures.js";
import { loadRecords } from "../src/records/load.js";

const SPECS = fileURLToPath(new URL("./fixtures/specs/", import.meta.url));
const config = { spec: "https://example.com/openapi.yaml", symbols: { "POST /chat/completions": "chat.completions.create" } };
const observedAt = "2026-01-01";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function derive(after = "after.yaml", existing: Awaited<ReturnType<typeof loadRecords>>[number]["record"][] = []) {
  const entries = await changelog(`${SPECS}before.yaml`, `${SPECS}${after}`);
  const spec = parseSpec(await readFile(`${SPECS}${after}`, "utf8"));
  return deriveCandidates({ vendor: "openai", config, entries, spec, existing, observedAt });
}

describe("deriveCandidates", () => {
  it("turns deprecations and removals into candidate records and ignores the rest", async () => {
    const { candidates, ignored, unmapped } = await derive();
    expect(candidates.map((c) => c.record.id).sort()).toEqual([
      "openai:2026-01-01:functions-deprecated",
      "openai:2026-01-01:max-tokens-to-max-completion-tokens",
      "openai:2026-01-01:old-name-removed",
    ]);

    const rename = candidates.find((c) => c.record.id.endsWith("max-completion-tokens"))!;
    expect(rename.record).toMatchObject({
      status: "candidate",
      kind: "deprecation",
      classification: "mechanical",
      title: "Rename max_tokens to max_completion_tokens on chat.completions.create",
      surface: { endpoints: ["/chat/completions"], sdkSymbols: ["chat.completions.create"], fields: ["max_tokens"] },
      fix: { rulePackPath: "packs/openai/2026-01-01-max-tokens-to-max-completion-tokens/" },
    });
    expect(rename.record.sources[0]?.quoteId).toContain("deprecated in favor of `max_completion_tokens`");
    expect(Object.keys(rename.files)).toEqual(expect.arrayContaining(["rules/js/01-rename.yml", "rules/py/01-rename.yml"]));

    const functions = candidates.find((c) => c.record.id.endsWith("functions-deprecated"))!;
    expect(functions.record.classification).toBe("semantic");
    expect(functions.record.fix).toBeUndefined();
    expect(Object.keys(functions.files)).not.toContain("rules/js/01-rename.yml");

    expect(candidates.find((c) => c.record.id.endsWith("old-name-removed"))?.record.kind).toBe("breaking");

    expect(ignored).toMatchObject({ "new-optional-request-property": 2, "request-property-enum-value-added": 3, "request-property-became-enum": 1 });
    expect(unmapped).toEqual(["POST /edits"]);
    expect(ignored["api-path-removed-without-deprecation (no symbol for POST /edits)"]).toBe(1);
  });

  it("writes packs that pass the fixture runner", async () => {
    const packs = await mkdtemp(join(tmpdir(), "darnit-corpus-"));
    tempDirs.push(packs);
    for (const c of (await derive()).candidates) {
      const dir = await writeCandidate(packs, c);
      const results = await runPackFixtures(dir, c.record);
      for (const r of results) expect(r.problems, c.record.id).toEqual([]);
    }
    const written = await readFile(join(packs, "openai", "2026-01-01-max-tokens-to-max-completion-tokens", "fixtures", "basic", "after", "app.py"), "utf8");
    expect(written).toBe("r = client.chat.completions.create(max_completion_tokens=1)\n");
  });

  it("does not regenerate a change that is already recorded", async () => {
    const existing = (await loadRecords()).map((l) => l.record);
    const { candidates, ignored } = await derive("after.yaml", existing);
    expect(candidates.map((c) => c.record.id)).not.toContain("openai:2026-01-01:max-tokens-to-max-completion-tokens");
    expect(candidates.map((c) => c.record.id)).not.toContain("openai:2026-01-01:functions-deprecated");
    expect(ignored["request-property-deprecated (already recorded)"]).toBe(2);
  });

  it("merges the same change across endpoints into one record", async () => {
    const spec = parseSpec(await readFile(`${SPECS}after.yaml`, "utf8"));
    spec.paths!["/other"] = spec.paths!["/chat/completions"]!;
    const entry = (path: string) => ({ id: "request-property-deprecated", level: 1 as const, text: "request property `max_tokens` deprecated", operation: "POST", path });
    const { candidates } = deriveCandidates({
      vendor: "openai",
      config: { ...config, symbols: { "POST /chat/completions": "chat.completions.create", "POST /other": "other.create" } },
      entries: [entry("/chat/completions"), entry("/other")],
      spec,
      existing: [],
      observedAt,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.record.surface).toEqual({
      endpoints: ["/chat/completions", "/other"],
      sdkSymbols: ["chat.completions.create", "other.create"],
      fields: ["max_tokens"],
    });
    expect(candidates[0]?.files["rules/js/01-rename.yml"]).toContain("regex: '(chat\\.completions\\.create|other\\.create)$'");
  });

  it("produces nothing from purely additive drift", async () => {
    const { candidates, ignored } = await derive("additive-after.yaml");
    expect(candidates).toEqual([]);
    expect(ignored).toEqual({ "new-optional-request-property": 1, "endpoint-added": 1 });
  });
});
