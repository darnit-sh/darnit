import { describe, expect, it } from "vitest";
import { basename } from "node:path";
import { ChangeRecordError, parseChangeRecord } from "../src/records/schema.js";
import { loadRecords } from "../src/records/load.js";

const valid = {
  id: "openai:2024-09-12:max-tokens-to-max-completion-tokens",
  status: "reviewed",
  vendor: "openai",
  announcedAt: "2024-09-12",
  kind: "deprecation",
  surface: { sdkSymbols: ["chat.completions.create"], fields: ["max_tokens"] },
  classification: "mechanical",
  sources: [{ url: "https://developers.openai.com/api/docs/api-reference/chat/create" }],
  detection: {
    astGrepPatterns: { js: [{ context: "({ max_tokens: $N })", selector: "pair" }] },
  },
};

describe("ChangeRecord schema", () => {
  it("accepts a minimal valid record", () => {
    expect(parseChangeRecord(valid, "x.json").id).toBe(valid.id);
  });

  it("requires a review status", () => {
    const noStatus = Object.fromEntries(Object.entries(valid).filter(([k]) => k !== "status"));
    expect(() => parseChangeRecord(noStatus, "x.json")).toThrow(/status/);
  });

  it("accepts each review status: candidate, parser-verified and reviewed", () => {
    for (const status of ["candidate", "parser-verified", "reviewed"]) expect(parseChangeRecord({ ...valid, status }, "x.json").status).toBe(status);
    expect(() => parseChangeRecord({ ...valid, status: "approved" }, "x.json")).toThrow(/status/);
  });

  it("rejects a record with no sources (every record is cited)", () => {
    expect(() => parseChangeRecord({ ...valid, sources: [] }, "x.json")).toThrow(ChangeRecordError);
  });

  it("rejects a surface with neither sdkSymbols nor endpoints", () => {
    expect(() => parseChangeRecord({ ...valid, surface: { fields: ["max_tokens"] } }, "x.json")).toThrow(/sdkSymbols or endpoints/);
  });

  it("rejects source urls that are not plain https", () => {
    for (const url of ["javascript:alert(1)", "http://example.com", "https://a.example/x)<img src=x>", "https://a.example/ @octocat"]) {
      expect(() => parseChangeRecord({ ...valid, sources: [{ url }] }, "x.json")).toThrow(ChangeRecordError);
    }
  });

  it("rejects null for an absent optional field (omit, never null)", () => {
    expect(() => parseChangeRecord({ ...valid, effectiveAt: null }, "x.json")).toThrow(ChangeRecordError);
  });

  it("rejects bare-string ast-grep patterns (context + selector only)", () => {
    const bare = { ...valid, detection: { astGrepPatterns: { js: ["max_tokens: $N"] } } };
    expect(() => parseChangeRecord(bare, "x.json")).toThrow(/expected object, received string/);
  });

  it("rejects unknown keys so typos fail loudly", () => {
    expect(() => parseChangeRecord({ ...valid, clasification: "mechanical" }, "x.json")).toThrow(
      ChangeRecordError,
    );
  });

  it("rejects an id that disagrees with vendor/announcedAt", () => {
    expect(() => parseChangeRecord({ ...valid, vendor: "stripe" }, "x.json")).toThrow(/id must be/);
  });
});

describe("packs/ corpus", () => {
  it("loads every committed ChangeRecord and each lives in a directory named after its id", async () => {
    const loaded = await loadRecords();
    // Candidates from the weekly corpus run sit alongside these.
    expect(loaded.map((l) => l.record.id)).toEqual(
      expect.arrayContaining(["openai:2023-11-06:chat-functions-to-tools", "openai:2024-09-12:max-tokens-to-max-completion-tokens"]),
    );
    for (const { record, packDir } of loaded) {
      const [vendor, date, slug] = record.id.split(":");
      expect(basename(packDir)).toBe(`${date}-${slug}`);
      expect(packDir).toContain(`/${vendor}/`);
      if (record.fix?.rulePackPath) {
        expect(record.fix.rulePackPath.replace(/\/$/, "")).toBe(`packs/${vendor}/${date}-${slug}`);
      }
    }
  });
});
