import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { answerKey, exitCode, misses, RULES, summary } from "../scripts/answer-key.js";
import type { Report } from "../scripts/golden.js";
import { checkReport, mentionsToJson, recordNames, toJson } from "../src/check.js";
import { loadRecords } from "../src/records/load.js";

const root = mkdtempSync(join(tmpdir(), "darnit-answer-key-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(
  join(root, "app.py"),
  ["from openai import OpenAI", "client = OpenAI()", 'client.chat.completions.create(model="gpt-4-32k", messages=[])', "x = o1 + 1", "# o1 is fast", ""].join("\n"),
);
writeFileSync(
  join(root, "notes.md"),
  ["We moved off gpt-4 last year.", "gpt-4-0613 is old too.", "Not my_gpt-4 though.", "Ask the ada team.", `${"x ".repeat(2600)}o1 here`, 'Use "ada" here.', "engine: davinci", ""].join("\n"),
);

const ids = new Set((await loadRecords()).flatMap((l) => recordNames(l.record)));
const { hits, values, mentions, coverage } = await checkReport(root);
const report = (): Report => ({ scanned: coverage, hits: toJson(hits) as Report["hits"], possiblyAffected: toJson(values) as Report["possiblyAffected"], mentions: mentionsToJson(mentions) });

describe("answer key for model-name mentions", () => {
  it("agrees with darnit on the fixture, with each line only the search finds explained by its rule", async () => {
    const t = await answerKey(root, report(), ids);
    expect(t.unexplained).toEqual([]);
    // The call site line holds gpt-4 inside gpt-4-32k too.
    expect(t.explained).toEqual({ "call site": 2, "longer id": 1, "longer name": 1, "letters only": 1, "long line": 1, "code name": 1 });
    expect(Object.keys(RULES).every((r) => r in t.explained)).toBe(true);
    expect(t.agreed).toBe(5);
    expect(summary(t)).toBe("mentions 12, agreed 5, explained 7 (call site 2, longer id 1, longer name 1, letters only 1, long line 1, code name 1), unexplained 0");
    expect(exitCode(t)).toBe(0);
  });

  it("fails on a line only one side has and no rule explains, naming the side", async () => {
    const r = report();
    // A plain mention, a quoted letters-only id, a setting value and an id in a comment: darnit counts each, so none may be explained away.
    const dropped = ["notes.md:1", "notes.md:6", "notes.md:7", "app.py:5"];
    r.mentions = r.mentions.filter((m) => !dropped.includes(`${m.file}:${m.line}`));
    r.mentions.push({ id: "x", file: "notes.md", line: 3, model: "gpt-4-32k" });
    const t = await answerKey(root, r, ids);
    expect(misses(t).sort()).toEqual([
      "app.py:5 o1 only in search",
      "notes.md:1 gpt-4 only in search",
      "notes.md:3 gpt-4-32k only in darnit",
      "notes.md:6 ada only in search",
      "notes.md:7 davinci only in search",
    ]);
    expect(exitCode(t)).toBe(1);
    expect(exitCode({ ...t, unexplained: [] }, ["could not fetch a/b"])).toBe(1);
  });

  it("leaves out files darnit reports as not checked, on both sides", async () => {
    const r = { ...report(), scanned: { ...coverage, tooLarge: ["notes.md"] } };
    r.mentions.push({ id: "x", file: "notes.md", line: 3, model: "gpt-4-32k" });
    const t = await answerKey(root, r, ids);
    expect(t.unexplained).toEqual([]);
    expect(t.mentions).toBe(4);
  });

  it("reads a crafted file full of ids in linear time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "darnit-answer-key-crafted-"));
    try {
      writeFileSync(join(dir, "a.py"), "x = o1 + ada\n".repeat(200_000));
      const started = performance.now();
      const t = await answerKey(dir, { scanned: { files: 1, records: 0 }, hits: [], possiblyAffected: [], mentions: [] }, ids);
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(t.explained).toEqual({ "code name": 200_000, "letters only": 200_000 });
      expect(t.unexplained).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
