import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { account, NotCoveredSchema, RemovalSchema, removalsFrom, type Removal } from "../src/corpus/accounting.js";
import { changelog } from "../src/corpus/oasdiff.js";
import { parseSpec, type Spec } from "../src/corpus/spec.js";
import { loadRecords } from "../src/records/load.js";
import { parseChangeRecord } from "../src/records/schema.js";
import { cpuTime } from "./helpers.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (rel: string) => readFile(join(ROOT, rel), "utf8");

const record = (slug: string, endpoints: string[], fields: string[], contexts = [`({ ${fields[0]}: $V })`]) =>
  parseChangeRecord(
    {
      id: `openai:2026-01-01:${slug}`,
      status: "candidate",
      vendor: "openai",
      announcedAt: "2026-01-01",
      kind: "deprecation",
      surface: { endpoints, fields },
      classification: "semantic",
      sources: [{ url: "https://example.com/openapi.yaml" }],
      detection: { astGrepPatterns: { js: contexts.map((context) => ({ context, selector: "pair" })) } },
    },
    `${slug}/change.json`,
  );

const body = (name: string) => ({ requestBody: { content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` } } } } });
// /a and /b both send Shared; /a also sends Model, whose enum lists two deprecated names.
const small = {
  paths: { "/a": { post: body("A") }, "/b": { post: body("Shared") }, "/a?beta=true": { post: body("BetaOnly") } },
  components: {
    schemas: {
      A: { allOf: [{ $ref: "#/components/schemas/Shared" }, { properties: { model: { $ref: "#/components/schemas/Model" } } }] },
      Shared: { properties: { old: { type: "string", deprecated: true }, self: { $ref: "#/components/schemas/Shared" } } },
      BetaOnly: { properties: { old: { deprecated: true } } },
      Model: { type: "string", enum: ["gpt-4", "gpt-4o"], "x-openai-enum-deprecations": { "gpt-4": { message: "" }, "gpt-4o": { message: "" } } },
      Response: { properties: { status: { deprecated: true } } },
    },
  },
};

describe("account", () => {
  it("names each kind of deprecated item by where it sits in the spec", () => {
    const spec = {
      paths: {
        "/a/{id}": {
          parameters: [{ name: "id", in: "path", deprecated: true }],
          get: { deprecated: true, parameters: [{ name: "limit", in: "query", deprecated: true }] },
        },
      },
      webhooks: { done: { post: { deprecated: true } } },
      components: {
        parameters: { Order: { name: "order", in: "query", deprecated: true } },
        schemas: { Item: { oneOf: [{ $ref: "#/components/schemas/Old", deprecated: true }, { type: "string", deprecated: true }] } },
      },
    };
    expect(account({ vendor: "openai", spec, removals: [], records: [], notCovered: [] }).unaccounted).toEqual([
      "/a/{id} parameter id",
      "GET /a/{id}",
      "GET /a/{id} parameter limit",
      "webhook done POST",
      "parameters Order",
      "schema Item oneOf Old",
      "schema Item oneOf 1",
    ]);
  });

  it("covers a property only when every endpoint whose request reaches it has a record", () => {
    const one = account({ vendor: "openai", spec: small, removals: [], records: [record("old-a", ["/v1/a"], ["old"])], notCovered: [] });
    expect(one.unaccounted).toContain("schema Shared property old");
    expect(one.covered.get("schema BetaOnly property old")).toEqual(["openai:2026-01-01:old-a"]);

    const both = account({ vendor: "openai", spec: small, removals: [], records: [record("old-a", ["/v1/a"], ["old"]), record("old-b", ["/v1/b"], ["old"])], notCovered: [] });
    expect(both.covered.get("schema Shared property old")).toEqual(["openai:2026-01-01:old-a", "openai:2026-01-01:old-b"]);
    expect(both.unaccounted).toEqual(["schema Model enum gpt-4", "schema Model enum gpt-4o", "schema Response property status"]);
  });

  it("covers a deprecated enum value only when a record's patterns name that exact value", () => {
    const gpt4o = record("gpt-4o", ["/v1/a"], ["model"], ['({ model: "gpt-4o" })']);
    const result = account({ vendor: "openai", spec: small, removals: [], records: [gpt4o], notCovered: [] });
    expect(result.covered.get("schema Model enum gpt-4o")).toEqual([gpt4o.id]);
    expect(result.unaccounted).toContain("schema Model enum gpt-4");
  });

  it("sorts not-covered entries into reasons, open items, and entries that name nothing or a covered item", () => {
    const result = account({
      vendor: "openai",
      spec: small,
      removals: [],
      records: [record("old-a", ["/v1/a"], ["old"])],
      notCovered: [
        { items: ["schema Response property status"], reason: "Response-only field." },
        { items: ["schema Shared property old"], "needs-record": "Report old on /b." },
        { items: ["schema BetaOnly property old", "schema Gone property x"], reason: "Already covered." },
        { items: ["schema Model enum gpt-4", "schema Model enum gpt-4o"], reason: "Model names." },
      ],
    });
    expect(result.reasons).toEqual(["schema Model enum gpt-4", "schema Model enum gpt-4o", "schema Response property status"]);
    expect(result.needsRecord).toEqual([{ key: "schema Shared property old", proposal: "Report old on /b." }]);
    expect(result.unaccounted).toEqual([]);
    expect(result.stale).toEqual(["schema Gone property x"]);
    expect(result.redundant).toEqual([{ key: "schema BetaOnly property old", ids: ["openai:2026-01-01:old-a"] }]);
  });

  it("joins a removed request field to the record for it, and needs an entry for every other removal", () => {
    const removals: Removal[] = [
      { observedAt: "2026-01-01", id: "request-property-removed", operation: "POST", path: "/b", text: "removed the request property `gone`" },
      { observedAt: "2026-01-01", id: "request-property-removed", operation: "POST", path: "/b", text: "removed the request property `a/b`" },
      { observedAt: "2026-01-01", id: "api-schema-removed", text: "removed the schema `Old`" },
    ];
    const result = account({ vendor: "openai", spec: {}, removals, records: [record("gone", ["/b"], ["gone"])], notCovered: [] });
    expect([...result.covered.keys()]).toEqual(["POST /b request-property-removed gone"]);
    expect(result.unaccounted).toEqual(["POST /b request-property-removed a/b", "api-schema-removed Old"]);
  });

  it("logs every removal in a corpus diff, and nothing else", async () => {
    const specs = join(ROOT, "test", "fixtures", "specs");
    const removed = removalsFrom(await changelog(join(specs, "before.yaml"), join(specs, "after.yaml")), "2026-01-01");
    expect(removed.map((r) => [r.id, r.operation, r.path]).sort()).toEqual([
      ["api-path-removed-without-deprecation", "POST", "/edits"],
      ["request-property-removed", "POST", "/chat/completions"],
    ]);
    expect(RemovalSchema.array().parse(removed)).toEqual(removed);
  });

  it("rejects an entry listed twice, or with both a reason and needs-record", () => {
    expect(NotCoveredSchema.safeParse([{ items: ["x"], reason: "r" }, { items: ["x"], reason: "r" }]).success).toBe(false);
    expect(NotCoveredSchema.safeParse([{ items: ["x"], reason: "r", "needs-record": "n" }]).success).toBe(false);
    expect(NotCoveredSchema.safeParse([{ items: ["x"] }]).success).toBe(false);
  });
});

describe("npm run accounting", () => {
  let spec: Spec;
  let removals: string;
  const tempDirs: string[] = [];
  beforeAll(async () => {
    spec = parseSpec(await read("corpus/openai/openapi.yaml"));
    removals = await read("corpus/openai/removals.json");
  });
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  // A corpus folder holding a changed copy of OpenAI's spec, written as JSON, which YAML reads too.
  async function run(change: (s: Spec) => void, removalsText = removals) {
    const dir = await mkdtemp(join(tmpdir(), "darnit-accounting-"));
    tempDirs.push(dir);
    const copy = structuredClone(spec);
    change(copy);
    await mkdir(join(dir, "openai"));
    await writeFile(join(dir, "openai", "openapi.yaml"), JSON.stringify(copy));
    await writeFile(join(dir, "openai", "removals.json"), removalsText);
    return spawnSync(join(ROOT, "node_modules", ".bin", "tsx"), ["scripts/accounting.ts", "--corpus", dir], { cwd: ROOT, encoding: "utf8" });
  }
  const schema = (s: Spec, name: string) => s.components!.schemas![name]!;

  it("accounts for every deprecation and removal in the committed corpus", async () => {
    const result = account({
      vendor: "openai",
      spec,
      removals: RemovalSchema.array().parse(JSON.parse(removals)),
      records: (await loadRecords()).map((l) => l.record),
      notCovered: NotCoveredSchema.parse(parseYaml(await read("packs/openai/not-covered.yaml"))),
    });
    expect({ unaccounted: result.unaccounted, stale: result.stale, redundant: result.redundant }).toEqual({ unaccounted: [], stale: [], redundant: [] });
    expect(result.deprecated).toBeGreaterThan(200);
    expect(result.removals).toBeGreaterThan(20);
  });

  it("fails on a new deprecated property, naming it with control characters escaped", async () => {
    const out = await run((s) => {
      schema(s, "CreateImageRequest").properties!.fake_field = { type: "string", deprecated: true };
      schema(s, "CreateImageRequest").properties!["evil\u001b[2J\u202e\nforged"] = { type: "string", deprecated: true };
    });
    expect(out.status).toBe(1);
    expect(out.stdout).toContain('  "schema CreateImageRequest property fake_field"\n');
    expect(out.stdout).toContain('  "schema CreateImageRequest property evil\\u001b[2J\\u202e\\nforged"\n');
    expect(out.stdout).not.toContain("\u001b");
    expect(out.stdout).not.toContain("\u202e");
  });

  it("fails on a reason entry for an item no longer in the spec", async () => {
    const out = await run((s) => delete schema(s, "OpenAIFile").properties!.status!.deprecated);
    expect(out.status).toBe(1);
    expect(out.stdout).toMatch(/no longer in the spec or the corpus history.*\n {2}"schema OpenAIFile property status"\n/);
    expect(out.stdout).toContain("0 unaccounted for");
  });

  it("fails on a removal the corpus logged that nothing accounts for", async () => {
    const extra = { observedAt: "2026-01-01", id: "request-property-removed", operation: "POST", path: "/responses", text: "removed the request property `fake_removed`" };
    const out = await run(() => {}, JSON.stringify([...(JSON.parse(removals) as unknown[]), extra]));
    expect(out.status).toBe(1);
    expect(out.stdout).toContain('  "POST /responses request-property-removed fake_removed"\n');
  });

  it("accounts for OpenAI's whole spec within its time budget", async () => {
    const records = (await loadRecords()).map((l) => l.record);
    const ms = await cpuTime(() => account({ vendor: "openai", spec, removals: [], records, notCovered: [] }), 3, 500);
    expect(ms).toBeLessThan(500);
  });
});
