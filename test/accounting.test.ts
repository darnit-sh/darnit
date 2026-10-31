import { execFile, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  account,
  appendRemovals,
  deprecatedItems,
  NotCoveredSchema,
  openItems,
  RemovalSchema,
  removalItems,
  removalsFrom,
  readRemovals,
  type Removal,
} from "../src/corpus/accounting.js";
import { deriveCandidates } from "../src/corpus/candidates.js";
import { changelog } from "../src/corpus/oasdiff.js";
import { parseSpec, type Spec } from "../src/corpus/spec.js";
import { loadRecords } from "../src/records/load.js";
import { parseChangeRecord } from "../src/records/schema.js";
import { cpuTime } from "./helpers.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const tsx = join(ROOT, "node_modules", ".bin", "tsx");

const record = (slug: string, endpoints: string[], fields: string[], contexts = [`({ ${fields[0] ?? "x"}: $V })`], sdkSymbols?: string[]) =>
  parseChangeRecord(
    {
      id: `openai:2026-01-01:${slug}`,
      status: "candidate",
      vendor: "openai",
      announcedAt: "2026-01-01",
      kind: "deprecation",
      surface: { endpoints, fields, ...(sdkSymbols ? { sdkSymbols } : {}) },
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
    // The spec's "/a?beta=true" is its own surface: a record for /a does not cover it.
    expect(one.unaccounted).toContain("schema BetaOnly property old");
    const beta = record("old-beta", ["/v1/a?beta=true"], ["old"]);
    expect(account({ vendor: "openai", spec: small, removals: [], records: [beta], notCovered: [] }).covered.get("schema BetaOnly property old")).toEqual([beta.id]);

    const both = account({ vendor: "openai", spec: small, removals: [], records: [record("old-a", ["/v1/a"], ["old"]), record("old-b", ["/v1/b"], ["old"]), beta], notCovered: [] });
    expect(both.covered.get("schema Shared property old")).toEqual(["openai:2026-01-01:old-a", "openai:2026-01-01:old-b"]);
    expect(both.unaccounted).toEqual(["schema Model enum gpt-4", "schema Model enum gpt-4o", "schema Response property status"]);
  });

  it("covers a deprecated enum value only when a record for a field holding it sets that field to that exact value", () => {
    const gpt4o = record("gpt-4o", ["/v1/a"], ["model"], ['({ model: "gpt-4o" })']);
    const result = account({ vendor: "openai", spec: small, removals: [], records: [gpt4o], notCovered: [] });
    expect(result.covered.get("schema Model enum gpt-4o")).toEqual([gpt4o.id]);
    expect(result.unaccounted).toContain("schema Model enum gpt-4");

    const voice = record("voice", ["/v1/a"], ["voice"], ['({ voice: "gpt-4o" })']);
    const other = account({ vendor: "openai", spec: small, removals: [], records: [voice], notCovered: [] });
    expect(other.unaccounted).toContain("schema Model enum gpt-4o");
  });

  it("does not credit a record for /v1/chat/completions with a field on the legacy /completions", () => {
    const spec = {
      paths: { "/completions": { post: body("CreateCompletionRequest") }, "/chat/completions": { post: body("CreateChatCompletionRequest") } },
      components: { schemas: { CreateCompletionRequest: { properties: { max_tokens: { deprecated: true } } }, CreateChatCompletionRequest: { properties: { max_tokens: { deprecated: true } } } } },
    };
    const maxTokens = record("max-tokens", ["/v1/chat/completions"], ["max_tokens"]);
    const result = account({ vendor: "openai", spec, removals: [], records: [maxTokens], notCovered: [] });
    expect(result.unaccounted).toEqual(["schema CreateCompletionRequest property max_tokens"]);
    expect([...result.covered.keys()]).toEqual(["schema CreateChatCompletionRequest property max_tokens"]);

    // Candidate derivation shares the rule: the same field on /completions is a new candidate, not "already recorded".
    const entries = [{ id: "request-property-deprecated", level: 1 as const, text: "request property `max_tokens` deprecated", operation: "POST", path: "/completions" }];
    const derived = deriveCandidates({ vendor: "openai", config: { spec: "https://example.com/openapi.yaml" }, entries, spec: {}, existing: [maxTokens], observedAt: "2026-01-01" });
    expect(derived.candidates.map((c) => c.record.surface.endpoints)).toEqual([["/completions"]]);
  });

  it("keeps a spec path's query, so a record for /images/edits is not taken for /images/edits?beta=true", async () => {
    const records = (await loadRecords()).map((l) => l.record);
    const entries = [{ id: "request-property-deprecated", level: 1 as const, text: "request property `user` deprecated", operation: "POST", path: "/images/edits?beta=true" }];
    const derived = deriveCandidates({ vendor: "openai", config: { spec: "https://example.com/openapi.yaml" }, entries, spec: {}, existing: records, observedAt: "2026-01-01" });
    expect(derived.candidates.map((c) => c.record.surface.endpoints)).toEqual([["/images/edits?beta=true"]]);
  });

  it("covers a deprecated operation or request schema by a record for the endpoint or its SDK call", () => {
    const spec = {
      paths: { "/old": { post: { deprecated: true, ...body("OldRequest") }, get: { deprecated: true } } },
      components: { schemas: { OldRequest: { deprecated: true } } },
    };
    const run = (...records: ReturnType<typeof record>[]) =>
      account({ vendor: "openai", spec, removals: [], records, notCovered: [], symbols: { "POST /old": "old.create" } });
    expect(run().unaccounted).toEqual(["POST /old", "GET /old", "schema OldRequest"]);
    expect(run(record("post-old", ["POST /v1/old"], [])).unaccounted).toEqual(["GET /old"]);
    expect(run(record("old", ["/v1/old"], [])).unaccounted).toEqual([]);
    expect(run(record("old-call", ["/v1/elsewhere"], [], undefined, ["old.create"])).unaccounted).toEqual(["GET /old"]);
    // A record for one field of the endpoint does not cover the whole operation.
    expect(run(record("old-field", ["/v1/old"], ["x"])).unaccounted).toEqual(["POST /old", "GET /old", "schema OldRequest"]);
  });

  it("walks a YAML alias that contains itself once", () => {
    const spec = parseSpec("components:\n  schemas:\n    Loop: &loop\n      deprecated: true\n      properties:\n        again: *loop\n");
    expect(deprecatedItems(spec).map((i) => i.key)).toEqual(["schema Loop"]);
  });

  it("sorts not-covered entries into reasons, open items, and entries that name nothing or a covered item", () => {
    const result = account({
      vendor: "openai",
      spec: small,
      removals: [],
      records: [record("old-a", ["/v1/a"], ["old"]), record("old-beta", ["/v1/a?beta=true"], ["old"])],
      notCovered: [
        { items: ["schema Response property status"], reason: "Response-only field." },
        { items: ["schema Shared property old"], "needs-record": "Report old on /b." },
        { items: ["schema BetaOnly property old", "schema Gone property x"], reason: "Already covered." },
        { items: ["schema Model enum gpt-4", "schema Model enum gpt-4o"], reason: "Model names." },
      ],
    });
    expect(result.reasons).toEqual(["schema Model enum gpt-4", "schema Model enum gpt-4o", "schema Response property status"]);
    expect(result.needsRecord).toEqual([{ key: "schema Shared property old", proposal: "Report old on /b.", date: undefined }]);
    expect(result.unaccounted).toEqual([]);
    expect(result.stale).toEqual(["schema Gone property x"]);
    expect(result.redundant).toEqual([{ key: "schema BetaOnly property old", ids: ["openai:2026-01-01:old-beta"] }]);
  });

  it("joins a removed request field to the record for it, and needs an entry for every other removal", () => {
    const removals: Removal[] = [
      { observedAt: "2026-01-01", id: "request-property-removed", operation: "POST", path: "/b", text: "removed the request property `gone`" },
      { observedAt: "2026-01-01", id: "request-property-removed", operation: "POST", path: "/b", text: "removed the request property `a/b`" },
      { observedAt: "2026-01-01", id: "api-schema-removed", text: "removed the schema `Old`" },
      { observedAt: "2026-01-01", id: "api-removed-without-deprecation", operation: "POST", path: "/c", text: "api removed without deprecation" },
    ];
    const result = account({ vendor: "openai", spec: {}, removals, records: [record("gone", ["/b"], ["gone"]), record("c", ["POST /v1/c"], [])], notCovered: [] });
    expect([...result.covered.keys()]).toEqual(["2026-01-01 POST /b request-property-removed `gone`", "2026-01-01 POST /c api-removed-without-deprecation"]);
    expect(result.unaccounted).toEqual(["2026-01-01 POST /b request-property-removed `a/b`", "2026-01-01 api-schema-removed `Old`"]);
  });

  it("keys each removal on everything that names it, so one entry cannot stand for another", () => {
    const at = { observedAt: "2026-01-01", operation: "GET", path: "/files" };
    const removals: Removal[] = [
      { ...at, id: "request-parameter-removed", text: "deleted the `query` request parameter `limit`" },
      { ...at, id: "request-parameter-removed", text: "deleted the `query` request parameter `purpose`" },
      { ...at, operation: "POST", path: "/images/edits", id: "request-property-enum-value-removed", text: "removed the enum value `auto` of the request property `background`" },
      { ...at, operation: "POST", path: "/images/edits", id: "request-property-enum-value-removed", text: "removed the enum value `auto` of the request property `quality`" },
      { ...at, operation: "POST", path: "/x", id: "request-property-removed", text: "removed the request property `a` (media type: multipart/form-data)" },
      { ...at, operation: "POST", path: "/x", id: "request-property-removed", text: "removed the request property `a` (media type: application/json)" },
    ];
    expect(removalItems(removals).map((i) => i.key)).toEqual([
      "2026-01-01 GET /files request-parameter-removed `query` `limit`",
      "2026-01-01 GET /files request-parameter-removed `query` `purpose`",
      "2026-01-01 POST /images/edits request-property-enum-value-removed `auto` `background`",
      "2026-01-01 POST /images/edits request-property-enum-value-removed `auto` `quality`",
      "2026-01-01 POST /x request-property-removed `a` (multipart/form-data)",
      "2026-01-01 POST /x request-property-removed `a` (application/json)",
    ]);
    const result = account({
      vendor: "openai",
      spec: {},
      removals: removals.slice(0, 2),
      records: [record("purpose", ["/v1/files"], ["purpose"])],
      notCovered: [{ items: ["2026-01-01 GET /files request-parameter-removed `query` `limit`"], reason: "Meant for limit only." }],
    });
    expect(result.covered.get("2026-01-01 GET /files request-parameter-removed `query` `purpose`")).toEqual(["openai:2026-01-01:purpose"]);
    expect(account({ vendor: "openai", spec: {}, removals: removals.slice(0, 2), records: [], notCovered: [{ items: ["2026-01-01 GET /files request-parameter-removed `query` `limit`"], reason: "Meant for limit only." }] }).unaccounted).toEqual([
      "2026-01-01 GET /files request-parameter-removed `query` `purpose`",
    ]);
  });

  it("needs a new entry for a removal seen again on a later day, even with the same text", () => {
    const first: Removal = { observedAt: "2026-10-05", id: "request-property-enum-value-removed", operation: "POST", path: "/images/generations", text: "removed the enum value `standard` of the request property `quality`" };
    const again: Removal = { ...first, observedAt: "2026-11-06" };
    const notCovered = [{ items: ["2026-10-05 POST /images/generations request-property-enum-value-removed `standard` `quality`"], reason: "Not a removal." }];
    const result = account({ vendor: "openai", spec: {}, removals: [first, again], records: [], notCovered });
    expect(result.reasons).toContain("2026-10-05 POST /images/generations request-property-enum-value-removed `standard` `quality`");
    expect(result.unaccounted).toContain("2026-11-06 POST /images/generations request-property-enum-value-removed `standard` `quality`");
  });

  it("never lets a record that finds only some values of a field cover the whole field", () => {
    const spec = { paths: { "/embeddings": { post: body("CreateEmbeddingRequest") } }, components: { schemas: { CreateEmbeddingRequest: { properties: { model: { type: "string", deprecated: true } } } } } };
    // As a model shutdown record does: one field, many endpoints, and patterns for particular names only.
    const shutdown = record("shutdown", ["/v1/embeddings", "/v1/chat/completions"], ["model"], ['({ model: "text-embedding-ada-002" })', "f(model='text-embedding-ada-002')"]);
    const removal: Removal = { observedAt: "2026-11-06", id: "request-property-removed", operation: "POST", path: "/embeddings", text: "removed the request property `model`" };
    const result = account({ vendor: "openai", spec, removals: [removal], records: [shutdown], notCovered: [] });
    expect(result.unaccounted).toEqual(["schema CreateEmbeddingRequest property model", ...removalItems([removal]).map((i) => i.key)]);

    // Candidate derivation shares the rule: such a record no longer counts a removed model field as recorded.
    const entries = [{ id: removal.id, level: 3 as const, text: removal.text, operation: "POST", path: "/embeddings" }];
    const derived = deriveCandidates({ vendor: "openai", config: { spec: "https://example.com/openapi.yaml" }, entries, spec: {}, existing: [shutdown], observedAt: "2026-11-06" });
    expect(derived.candidates.map((c) => c.record.surface.fields)).toEqual([["model"]]);

    const removed = { ...removal, path: "/x", text: "removed the request property `x`" };
    for (const context of ["({ x: $V })", "({ x })", '({ "x": $V })', "f(x=$V)", '{"x": $V}'])
      expect(account({ vendor: "openai", spec: {}, removals: [removed], records: [record("any", ["/v1/x"], ["x"], [context])], notCovered: [] }).unaccounted, context).toEqual([]);
  });

  it("flags a reason the spec or the log contradicts", () => {
    const spec = {
      paths: { "/a": { post: body("Sent") } },
      components: { schemas: { Sent: { properties: { old: { deprecated: true } } }, Read: { properties: { old: { deprecated: true } } }, Note: { deprecated: true, description: "Kept for SDK compatibility." } } },
    };
    const removals: Removal[] = [
      { observedAt: "2026-01-01", id: "response-optional-property-removed", operation: "GET", path: "/a", text: "removed the optional property `x` from the response with the `200` status" },
      { observedAt: "2026-01-01", id: "request-property-enum-value-removed", operation: "POST", path: "/a", text: "removed the enum value `y` of the request property `z`" },
    ];
    const [response, request] = removalItems(removals).map((i) => i.key);
    const result = account({
      vendor: "openai",
      spec,
      removals,
      records: [],
      notCovered: [
        { items: ["schema Read property old", "schema Sent property old", response!, request!], reason: "Response-only." },
        { items: ["schema Note"], reason: 'The spec says "Kept for SDK compatibility." and "Never worked."' },
      ],
    });
    expect(result.reasons).toHaveLength(5);
    expect(result.contradicted).toEqual(["schema Sent property old", "schema Note", request]);
  });

  it("lists open items soonest first, undated last, and flags dates already past", () => {
    const open = [
      { key: "c", proposal: "No date." },
      { key: "b", proposal: "Later.", date: "2027-01-14" },
      { key: "a", proposal: "Passed.", date: "2026-07-23" },
      { key: "a2", proposal: "Passed.", date: "2026-07-23" },
    ];
    expect(openItems(open, "2026-10-31")).toEqual([
      { proposal: "Passed.", date: "2026-07-23", past: true, keys: ["a", "a2"] },
      { proposal: "Later.", date: "2027-01-14", past: false, keys: ["b"] },
      { proposal: "No date.", date: undefined, past: false, keys: ["c"] },
    ]);
    expect(NotCoveredSchema.safeParse([{ items: ["x"], reason: "r", date: "2026-01-01" }]).success).toBe(false);
    expect(NotCoveredSchema.safeParse([{ items: ["x"], "needs-record": "n", date: "soon" }]).success).toBe(false);
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

  it("appends to the removals log, starts one when there is none, and never replaces one it cannot read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "darnit-removals-"));
    try {
      const file = join(dir, "removals.json");
      const one: Removal = { observedAt: "2026-01-01", id: "api-schema-removed", text: "removed the schema `A`" };
      const two: Removal = { ...one, text: "removed the schema `B`" };
      await appendRemovals(file, [one]);
      await appendRemovals(file, [two]);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual([one, two]);
      const denied = () => Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));
      await expect(appendRemovals(file, [one], denied)).rejects.toThrow("EACCES");
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual([one, two]);
      // An empty file is a log that lost its contents, not an empty log.
      await writeFile(file, "");
      await expect(appendRemovals(file, [one])).rejects.toThrow();
      expect(await readFile(file, "utf8")).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an entry listed twice, or with both a reason and needs-record", () => {
    expect(NotCoveredSchema.safeParse([{ items: ["x"], reason: "r" }, { items: ["x"], reason: "r" }]).success).toBe(false);
    expect(NotCoveredSchema.safeParse([{ items: ["x"], reason: "r", "needs-record": "n" }]).success).toBe(false);
    expect(NotCoveredSchema.safeParse([{ items: ["x"] }]).success).toBe(false);
  });
});

describe("npm run accounting", () => {
  // Tests run on this small corpus only. The committed one changes with every refresh, and `npm run accounting`,
  // which CI runs on its own, is what checks it; `npm run check` must pass on a refresh that adds new items.
  const FIXTURE = join(ROOT, "test", "fixtures", "accounting");
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  // A copy of the fixture corpus, its spec (written as JSON, which YAML reads too) or removals log changed.
  async function run(change: { spec?: (s: Spec) => void; specText?: string; removals?: (log: Removal[]) => void } = {}, env: Record<string, string> = {}) {
    const dir = await mkdtemp(join(tmpdir(), "darnit-accounting-"));
    tempDirs.push(dir);
    await cp(FIXTURE, dir, { recursive: true });
    const specFile = join(dir, "corpus", "openai", "openapi.yaml");
    const logFile = join(dir, "corpus", "openai", "removals.json");
    if (change.spec) {
      const s = parseSpec(await readFile(specFile, "utf8"));
      change.spec(s);
      await writeFile(specFile, JSON.stringify(s));
    }
    if (change.specText !== undefined) await writeFile(specFile, change.specText);
    if (change.removals) {
      const log = await readRemovals(logFile);
      change.removals(log);
      await writeFile(logFile, JSON.stringify(log));
    }
    return spawnSync(tsx, ["scripts/accounting.ts", "--root", dir], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env } });
  }
  const schema = (s: Spec, name: string) => s.components!.schemas![name]!;

  it("accounts for every item in its corpus", async () => {
    const out = await run();
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("openai: 7 deprecated in the spec, 2 removals in the corpus history\n");
    expect(out.stdout).toContain("  1 covered by records, 4 with a reason, 4 need a record, 0 unaccounted for\n");
  });

  it("fails on a new deprecated property, naming it with control characters escaped, and lists open items soonest first", async () => {
    const out = await run({
      spec: (s) => {
        schema(s, "CreateImageRequest").properties!.fake_field = { type: "string", deprecated: true };
        schema(s, "CreateImageRequest").properties!["evil\u001b[2J‮\nforged"] = { type: "string", deprecated: true };
      },
    });
    expect(out.status).toBe(1);
    expect(out.stdout).toContain('  "schema CreateImageRequest property fake_field"\n');
    expect(out.stdout).toContain('  "schema CreateImageRequest property evil\\u001b[2J\\u202e\\nforged"\n');
    expect(out.stdout).not.toContain("\u001b");
    expect(out.stdout).not.toContain("‮");
    const open = out.stdout.split("\n").filter((l) => l.startsWith("  - "));
    expect(open.map((l) => l.slice(4, l.indexOf(":")))).toEqual(["2026-07-23, already past", "2026-08-26, already past", "2099-01-01", "no date"]);
    expect(out.stdout).toMatch(/\n {2}- 2026-08-26, already past: Breaking, .*\n {6}"POST \/assistants"/);
  });

  it("fails on a reason entry for an item no longer in the spec", async () => {
    const out = await run({ spec: (s) => delete schema(s, "ImagesResponse").properties!.status!.deprecated });
    expect(out.status).toBe(1);
    expect(out.stdout).toMatch(/no longer in the spec or the corpus history.*\n {2}"schema ImagesResponse property status"\n/);
    expect(out.stdout).toContain("0 unaccounted for");
  });

  it("fails on a removal the corpus logged that nothing accounts for", async () => {
    const extra = { observedAt: "2026-01-01", id: "request-property-removed", operation: "POST", path: "/responses", text: "removed the request property `fake_removed`" };
    const out = await run({ removals: (log) => log.push(extra) });
    expect(out.status).toBe(1);
    expect(out.stdout).toContain('  "2026-01-01 POST /responses request-property-removed `fake_removed`"\n');
  });

  it("fails on a reason the spec no longer bears out", async () => {
    const out = await run({
      spec: (s) => {
        schema(s, "CreateImageRequest").properties!.echo = { $ref: "#/components/schemas/ImagesResponse" };
        const model = schema(s, "CreateImageRequest").properties!.model as { "x-openai-enum-deprecations": Record<string, { message: string }> };
        model["x-openai-enum-deprecations"]["gpt-5.1-mini"]!.message = "Retired.";
      },
    });
    expect(out.status).toBe(1);
    expect(out.stdout).toMatch(/contradicts \(correct them\):\n {2}"schema CreateImageRequest property model enum gpt-5.1-mini"\n {2}"schema ImagesResponse property status"\n/);
  });

  it("fences all it prints in GitHub Actions, including a spec that does not parse, so no spec text runs as a workflow command", async () => {
    const fenced = (out: { stdout: string; stderr: string }) => {
      const lines = out.stdout.trimEnd().split("\n");
      const token = /^::stop-commands::([0-9a-f-]{36})$/.exec(lines[0]!)?.[1];
      expect(token, lines[0]).toBeDefined();
      expect(lines.at(-1)).toBe(`::${token}::`);
      expect(lines.slice(1, -1).filter((l) => l.startsWith("::"))).toEqual([]);
      expect(out.stderr).toBe("");
    };
    const broken = await run({ specText: "openapi: 3.1.0\n::error title=pwned::forged: a: b\n" }, { GITHUB_ACTIONS: "true" });
    expect(broken.status).toBe(1);
    fenced(broken);
    expect(broken.stdout).toContain('accounting stopped: "Nested mappings are not allowed');
    expect(broken.stdout).toContain("\\n::error title=pwned::forged: a: b\\n");

    const named = await run({ spec: (s) => void (schema(s, "CreateImageRequest").properties!["::error title=pwned::x"] = { deprecated: true }) }, { GITHUB_ACTIONS: "true" });
    expect(named.status).toBe(1);
    fenced(named);
    expect(named.stdout).toContain('  "schema CreateImageRequest property ::error title=pwned::x"\n');
  });

  it("is the only check that reads the committed corpus: no test file does", async () => {
    // The committed corpus changes with every refresh; a test that reads it fails the refresh's `npm run check`.
    const committed = new RegExp(["ROOT,\\s*[\"']corpus[\"']", "ROOT,\\s*[\"']packs[\"'],\\s*[\"']openai", "[\"'`]corpus/openai", "[\"'`]packs/openai/not-covered"].join("|"));
    const files = (await readdir(join(ROOT, "test"), { recursive: true })).filter((f) => f.endsWith(".ts"));
    const offenders: string[] = [];
    for (const f of files) if (committed.test(await readFile(join(ROOT, "test", f), "utf8"))) offenders.push(f);
    expect(offenders).toEqual([]);
  });

  it("accounts for a large spec within its time budget", async () => {
    // 2,000 schemas of 20 properties each, chained by $ref into one cycle, behind 500 operations that each reach all of them.
    const schemas: Record<string, unknown> = {};
    for (let i = 0; i < 2000; i++) {
      const properties: Record<string, unknown> = {};
      for (let p = 0; p < 20; p++) properties[`p${p}`] = p === 0 ? { $ref: `#/components/schemas/S${(i + 1) % 2000}` } : { type: "string", deprecated: p % 5 === 0 };
      properties.model = { type: "string", enum: ["a", "b"], "x-openai-enum-deprecations": { a: { message: "" } } };
      schemas[`S${i}`] = { properties };
    }
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) paths[`/p${i}`] = { post: body(`S${i * 4}`) };
    const records = (await loadRecords()).map((l) => l.record);
    const spec = { paths, components: { schemas } };
    const ms = await cpuTime(() => account({ vendor: "openai", spec, removals: [], records, notCovered: [] }), 3, 1500);
    expect(ms).toBeLessThan(1500);
  });
});

// A spec whose removals make no candidate record: a schema, and an enum value of a request property.
const tinySpec = (values: string, extra: string) =>
  `openapi: 3.1.0\ninfo: { title: t, version: "1" }\npaths:\n  /speak:\n    post:\n      requestBody:\n        content:\n          application/json:\n            schema:\n              type: object\n              properties:\n                voice: { type: string, enum: [${values}] }\n      responses:\n        "200": { description: ok }\ncomponents:\n  schemas:\n    Kept: { type: string }\n${extra}`;

describe("npm run corpus", () => {
  const before = tinySpec("alloy, aube", "    Gone: { type: string }\n");
  const after = tinySpec("alloy", "");

  // Serves `after` as the vendor's spec to a corpus run whose last snapshot is `before`.
  async function refresh(seed: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "darnit-corpus-"));
    const server = createServer((_, res) => res.end(after));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const { port } = server.address() as AddressInfo;
      await mkdir(join(dir, "corpus", "openai"), { recursive: true });
      await writeFile(join(dir, "vendors.yml"), `openai:\n  spec: http://127.0.0.1:${port}/openapi.yaml\n`);
      await writeFile(join(dir, "corpus", "openai", "openapi.yaml"), before);
      await writeFile(join(dir, "corpus", "openai", "snapshot.json"), JSON.stringify({ sha256: "older" }));
      await seed(join(dir, "corpus", "openai"));
      const run = await promisify(execFile)(tsx, ["scripts/corpus.ts", "--root", dir], { cwd: ROOT }).then(
        () => 0,
        (err: { code?: number }) => err.code ?? 1,
      );
      const file = (name: string) => readFile(join(dir, "corpus", "openai", name), "utf8");
      return { run, removals: await file("removals.json"), spec: await file("openapi.yaml") };
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("appends the removals of each refresh to the log", async () => {
    const earlier: Removal = { observedAt: "2026-01-01", id: "api-schema-removed", text: "removed the schema `Earlier`" };
    const out = await refresh((dir) => writeFile(join(dir, "removals.json"), JSON.stringify([earlier])));
    expect(out.run).toBe(0);
    const log = RemovalSchema.array().parse(JSON.parse(out.removals));
    expect(log[0]).toEqual(earlier);
    const day = log[1]!.observedAt;
    expect(removalItems(log.slice(1)).map((i) => i.key)).toEqual([`${day} POST /speak request-property-enum-value-removed \`aube\` \`voice\``, `${day} api-schema-removed \`Gone\``]);
    expect(out.spec).toBe(after);
  });

  it("keeps the old spec when the log cannot be read, so the removals are taken again next run", async () => {
    const out = await refresh((dir) => writeFile(join(dir, "removals.json"), "not json"));
    expect(out.run).not.toBe(0);
    expect(out.removals).toBe("not json");
    expect(out.spec).toBe(before);
  });
});

describe("npm run corpus:backfill", () => {
  const git = (cwd: string, ...args: string[]) =>
    promisify(execFile)("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null", ...args], { cwd });
  const backfill = (root: string) =>
    promisify(execFile)(tsx, ["scripts/backfill-removals.ts", "--root", root], { cwd: ROOT }).then(
      (r) => ({ code: 0, stderr: r.stderr }),
      (err: { code?: number; stderr?: string }) => ({ code: err.code ?? 1, stderr: err.stderr ?? "" }),
    );

  it("replays every pair of snapshots in history, dated by the newer one, and refuses a shallow clone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "darnit-backfill-"));
    try {
      const repo = join(dir, "repo");
      await mkdir(join(repo, "corpus", "openai"), { recursive: true });
      await git(repo, "init", "-q");
      await writeFile(join(repo, "vendors.yml"), "openai:\n  spec: https://example.com/openapi.yaml\n");
      const snapshots: [string, string][] = [
        ["2026-01-01", tinySpec("alloy, aube", "    Gone: { type: string }\n")],
        ["2026-01-08", tinySpec("alloy", "    Gone: { type: string }\n")],
        ["2026-01-15", tinySpec("alloy", "")],
      ];
      for (const [fetchedAt, text] of snapshots) {
        await writeFile(join(repo, "corpus", "openai", "openapi.yaml"), text);
        await writeFile(join(repo, "corpus", "openai", "snapshot.json"), JSON.stringify({ fetchedAt }));
        await git(repo, "add", ".");
        await git(repo, "commit", "-q", "-m", fetchedAt);
      }
      expect((await backfill(repo)).code).toBe(0);
      const log = await readRemovals(join(repo, "corpus", "openai", "removals.json"));
      expect(removalItems(log).map((i) => i.key)).toEqual([
        "2026-01-08 POST /speak request-property-enum-value-removed `aube` `voice`",
        "2026-01-15 api-schema-removed `Gone`",
      ]);

      const shallow = join(dir, "shallow");
      await git(dir, "clone", "-q", "--depth", "1", `file://${repo}`, shallow);
      const out = await backfill(shallow);
      expect(out.code).toBe(1);
      expect(out.stderr).toContain("shallow");
      await expect(readFile(join(shallow, "corpus", "openai", "removals.json"))).rejects.toThrow("ENOENT");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
