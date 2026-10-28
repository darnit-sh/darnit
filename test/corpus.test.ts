import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { deriveCandidates, writeCandidate } from "../src/corpus/candidates.js";
import { changelog, type ChangeEntry } from "../src/corpus/oasdiff.js";
import { parseSpec, requestProperty, type Schema, type Spec } from "../src/corpus/spec.js";
import { runPackFixtures } from "../src/packs/fixtures.js";
import { findMatches, grammarFor } from "../src/scan/astgrep.js";
import { loadRecords } from "../src/records/load.js";

const YAML_DIR = fileURLToPath(new URL("./fixtures/specs/", import.meta.url));
const config = { spec: "https://example.com/openapi.yaml", symbols: { "POST /chat/completions": "chat.completions.create" } };
const observedAt = "2026-01-01";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function derive(after = "after.yaml", existing: Awaited<ReturnType<typeof loadRecords>>[number]["record"][] = []) {
  const entries = await changelog(`${YAML_DIR}before.yaml`, `${YAML_DIR}${after}`);
  const spec = parseSpec(await readFile(`${YAML_DIR}${after}`, "utf8"));
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
    expect(rename.record.sources[0]?.quoteId).toContain("deprecated in favor of `max_completion_tokens`");

    const functions = candidates.find((c) => c.record.id.endsWith("functions-deprecated"))!;
    expect(functions.record.classification).toBe("semantic");
    expect(functions.record.fix).toBeUndefined();
    expect(Object.keys(functions.files)).not.toContain("rules/js/01-rename.yml");

    expect(candidates.find((c) => c.record.id.endsWith("old-name-removed"))?.record.kind).toBe("breaking");

    expect(ignored).toMatchObject({ "new-optional-request-property": 2, "request-property-enum-value-added": 3, "request-property-became-enum": 1 });
    expect(unmapped).toEqual(["POST /edits"]);
    expect(ignored["api-path-removed-without-deprecation (no symbol for POST /edits)"]).toBe(1);
  });

  it("reports a deprecated field that names a replacement without rewriting it", async () => {
    const { candidates } = await derive();
    const rename = candidates.find((c) => c.record.id.endsWith("max-completion-tokens"))!;
    expect(rename.record).toMatchObject({
      status: "candidate",
      kind: "deprecation",
      classification: "semantic",
      title: "max_tokens is deprecated on chat.completions.create",
      surface: { endpoints: ["/chat/completions"], sdkSymbols: ["chat.completions.create"], fields: ["max_tokens"] },
      notes: {
        migration:
          "max_tokens is deprecated in favor of max_completion_tokens. Before renaming, check that your SDK version accepts max_completion_tokens on chat.completions.create calls.",
      },
    });
    expect(rename.record.fix).toBeUndefined();
    expect(Object.keys(rename.files).filter((f) => f.startsWith("rules/"))).toEqual([]);
    expect(rename.files["fixtures/basic/after/app.js"]).toBe(rename.files["fixtures/basic/before/app.js"]);
    expect(rename.files["fixtures/basic/after/app.py"]).toBe(rename.files["fixtures/basic/before/app.py"]);
  });

  it("detects a field as shorthand and as a quoted key", async () => {
    const { candidates } = await derive();
    const { js, py } = candidates.find((c) => c.record.id.endsWith("max-completion-tokens"))!.record.detection.astGrepPatterns;
    const jsSource = `const max_tokens = 1;\nf({ max_tokens });\nf({ max_tokens: 1 });\nf({ "max_tokens": 1 });\nf({ 'max_tokens': 1 });\nf({ other: 1 });\n`;
    const pySource = `f(max_tokens=1)\nf(json={"max_tokens": 1})\nf(json={'max_tokens': 1})\nf(json={"other": 1})\n`;
    expect(findMatches(jsSource, grammarFor("app.js")!.grammar, js!)).toHaveLength(4);
    expect(findMatches(pySource, grammarFor("app.py")!.grammar, py!)).toHaveLength(3);
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
    expect(written).toBe("r = client.chat.completions.create(max_tokens=1)\n");
  });

  it("does not regenerate a change that is already recorded", async () => {
    const existing = (await loadRecords()).map((l) => l.record);
    const { candidates, ignored } = await derive("after.yaml", existing);
    expect(candidates.map((c) => c.record.id)).not.toContain("openai:2026-01-01:max-tokens-to-max-completion-tokens");
    expect(candidates.map((c) => c.record.id)).not.toContain("openai:2026-01-01:functions-deprecated");
    expect(ignored["request-property-deprecated (already recorded)"]).toBe(2);
  });

  it("merges the same change across endpoints into one record", async () => {
    const spec = parseSpec(await readFile(`${YAML_DIR}after.yaml`, "utf8"));
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
  });

  it("only treats explicit replacement phrasing as a rename", async () => {
    const spec = parseSpec(await readFile(`${YAML_DIR}after.yaml`, "utf8"));
    const props = spec.components!.schemas!["Req"]!.properties!;
    props["max_tokens"]!.description = "Deprecated. Use this to cap output; prefer the newer field.";
    props["functions"]!.description = "Deprecated, use `tools` instead.";
    const entry = (field: string) => ({ id: "request-property-deprecated", level: 1 as const, text: `request property \`${field}\` deprecated`, operation: "POST", path: "/chat/completions" });
    const { candidates } = deriveCandidates({ vendor: "openai", config, entries: [entry("max_tokens"), entry("functions")], spec, existing: [], observedAt });
    expect(candidates.map((c) => c.record.id).sort()).toEqual(["openai:2026-01-01:functions-to-tools", "openai:2026-01-01:max-tokens-deprecated"]);
    expect(candidates.find((c) => c.record.id.endsWith("max-tokens-deprecated"))?.record.classification).toBe("semantic");
  });

  it("produces nothing from purely additive drift", async () => {
    const { candidates, ignored } = await derive("additive-after.yaml");
    expect(candidates).toEqual([]);
    expect(ignored).toEqual({ "new-optional-request-property": 1, "endpoint-added": 1 });
  });

  it("skips spec text that is not a plain name, with a note, instead of writing it into rules", () => {
    const bad = ["a'\n    strictness: 'x", "$K", "a b", "a`b", "max_tokens`x", "x".repeat(65)];
    const { candidates, ignored, unmapped } = synthetic(
      Object.fromEntries(bad.map((f) => [f, { description: "Deprecated in favor of `b`." }])),
      [...bad.map((f) => deprecated(f)), deprecated("max_tokens", "/chat/completions <img src=x>"), deprecated("max_tokens", "/chat/completions", "post")],
    );
    expect(candidates.flatMap((c) => Object.values(c.files)).join("\n")).not.toMatch(/strictness|\$K/);
    expect(candidates).toEqual([]);
    expect(unmapped).toEqual([]);
    expect(ignored).toEqual({
      "request-property-deprecated (field name is not a plain identifier, POST /chat/completions)": 6,
      "request-property-deprecated (endpoint is not a plain path)": 1,
      "request-property-deprecated (method is not a plain HTTP method)": 1,
    });
  });

  it("counts a nested property as nested whatever its path", () => {
    const { ignored } = synthetic({}, [deprecated("a/b", "/x y")]);
    expect(ignored).toEqual({ "request-property-deprecated (nested property)": 1 });
  });

  it("writes every candidate it derives, long names included", async () => {
    const long = `f${"x".repeat(63)}`;
    const { candidates, ignored } = synthetic(
      { [long]: { description: "Deprecated." }, short: { description: `Deprecated in favor of \`r${"x".repeat(300)}\`.` } },
      [deprecated(long), deprecated("short")],
    );
    expect(ignored).toEqual({});
    expect(candidates.map((c) => c.record.surface.fields)).toEqual([[long], ["short"]]);
    expect(candidates[1]?.record.id).toBe("openai:2026-01-01:short-deprecated");
    const packs = await mkdtemp(join(tmpdir(), "darnit-corpus-"));
    tempDirs.push(packs);
    for (const c of candidates) await writeCandidate(packs, c);
  });

  it("reads the parameter name, not its location, from a removed request parameter", () => {
    const entry = { id: "request-parameter-removed", level: 3 as const, text: "deleted the `query` request parameter `limit`", operation: "POST", path: "/chat/completions" };
    const { candidates } = synthetic({}, [entry]);
    expect(candidates.map((c) => c.record.surface.fields)).toEqual([["limit"]]);
  });

  it("gives names that differ only in case or underscores their own records", () => {
    const { candidates } = synthetic({}, ["MAX_TOKENS", "max_tokens", "_", "__"].map((f) => deprecated(f)));
    expect(candidates.map((c) => c.record.surface.fields)).toEqual([["MAX_TOKENS"], ["max_tokens"], ["_"], ["__"]]);
    expect(new Set(candidates.map((c) => c.record.id)).size).toBe(4);
  });

  it("never borrows a rename from a schema outside the spec's own components", () => {
    const { candidates } = synthetic(
      { max_tokens: { $ref: "https://evil.example/schemas/X" }, functions: { $ref: "other.yaml#/components/schemas/X" } },
      [deprecated("max_tokens"), deprecated("functions")],
      { X: { description: "Deprecated in favor of `evil`." } },
    );
    expect(candidates.map((c) => c.record.surface.fields)).toEqual([["max_tokens"], ["functions"]]);
    expect(candidates.map((c) => c.record.id)).toEqual(["openai:2026-01-01:max-tokens-deprecated", "openai:2026-01-01:functions-deprecated"]);
  });

  it("resolves each referenced schema once across many fields within a CPU budget", () => {
    const fields = Array.from({ length: 60 }, (_, i) => `f${i}`);
    const schemas: Record<string, Schema> = {};
    for (let i = 0; i < 100_000; i++) schemas[`C${i}`] = ref(`C${i + 1}`);
    schemas["C100000"] = { description: "Deprecated in favor of `g`." };
    const start = process.cpuUsage();
    const { candidates } = synthetic(Object.fromEntries(fields.map((f) => [f, ref("C0")])), fields.map((f) => deprecated(f)), schemas);
    const { user, system } = process.cpuUsage(start);
    expect(candidates).toHaveLength(60);
    expect(candidates.every((c) => c.record.id.endsWith("-to-g"))).toBe(true);
    expect((user + system) / 1000).toBeLessThan(1000);
  });
});

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });

function deprecated(field: string, path = "/chat/completions", operation = "POST") {
  return { id: "request-property-deprecated", level: 1 as const, text: `request property \`${field}\` deprecated`, operation, path };
}

function synthetic(properties: Record<string, Schema>, entries: ChangeEntry[], schemas: Record<string, Schema> = {}) {
  const spec: Spec = { paths: { "/chat/completions": { post: { requestBody: { content: { "application/json": { schema: { properties } } } } } } }, components: { schemas } };
  return deriveCandidates({ vendor: "openai", config, entries, spec, existing: [], observedAt });
}

describe("requestProperty", () => {
  it("stops at $ref cycles and follows long chains within a CPU budget", () => {
    const schemas: Record<string, Schema> = { A: ref("B"), B: ref("A"), Self: ref("Self") };
    for (let i = 0; i < 100_000; i++) schemas[`C${i}`] = ref(`C${i + 1}`);
    schemas["C100000"] = { properties: { max_tokens: ref("Self") } };
    const op = (name: string) => ({ post: { requestBody: { content: { "application/json": { schema: ref(name) } } } } });
    const spec: Spec = { paths: { "/a": op("A"), "/self": op("Self"), "/chain": op("C0") }, components: { schemas } };
    const start = process.cpuUsage();
    expect(requestProperty(spec, "POST", "/a", "max_tokens")).toBeUndefined();
    expect(requestProperty(spec, "POST", "/self", "max_tokens")).toBeUndefined();
    expect(requestProperty(spec, "POST", "/chain", "max_tokens")).toEqual(ref("Self"));
    expect(requestProperty(spec, "POST", "/chain", "constructor")).toBeUndefined();
    const odd = { paths: { "/x": { post: { requestBody: { content: { "application/json": { schema: { allOf: 1, $ref: 2 } } } } } } } } as unknown as Spec;
    expect(requestProperty(odd, "POST", "/x", "max_tokens")).toBeUndefined();
    const { user, system } = process.cpuUsage(start);
    expect((user + system) / 1000).toBeLessThan(1000);
  });
});
