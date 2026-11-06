import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  answerKey,
  applyKnown,
  exitCode,
  misses,
  notComparable,
  oneLine,
  parseKnown,
  RULES,
  summary,
  tally,
  unlisted,
} from "../scripts/answer-key.js";
import type { Report } from "../scripts/golden.js";
import { checkReport, mentionsToJson, toJson } from "../src/check.js";
import { loadRecords } from "../src/records/load.js";
import { recordModels } from "../src/records/schema.js";

const root = mkdtempSync(join(tmpdir(), "darnit-answer-key-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(
  join(root, "app.py"),
  [
    "from openai import OpenAI",
    "client = OpenAI()",
    'client.chat.completions.create(model="gpt-4-32k", messages=[])',
    "x = o1 + 1",
    "# o1 is fast",
    "",
  ].join("\n"),
);
writeFileSync(
  join(root, "notes.md"),
  [
    "We moved off gpt-4 last year.",
    "gpt-4-0613 is old too.",
    "Not my_gpt-4 though.",
    "Ask the ada team.",
    `${"x ".repeat(2600)}o1 here`,
    'Use "ada" here.',
    "engine: davinci",
    "",
  ].join("\n"),
);

const ids = new Map((await loadRecords()).map((l) => [l.record.id, new Set(recordModels(l.record))]));
const { hits, values, mentions, coverage } = await checkReport(root);
const report = (): Report => ({
  scanned: coverage,
  hits: toJson(hits) as Report["hits"],
  possiblyAffected: toJson(values) as Report["possiblyAffected"],
  mentions: mentionsToJson(mentions),
});

describe("answer key for model-name mentions", () => {
  it("agrees with darnit on the fixture, with each line only the search finds explained by its rule", async () => {
    const t = await answerKey(root, report(), ids);
    expect(t.unexplained).toEqual([]);
    expect(t.explained).toEqual({ "call site": 1, "longer id": 1, "letters only": 1, "long line": 1, "code name": 1 });
    expect(Object.keys(RULES).every((r) => r in t.explained)).toBe(true);
    expect(t.agreed).toBe(5);
    // my_gpt-4, and gpt-4 inside gpt-4-32k on the call site line, are parts of longer words: not mentions at all.
    expect(summary(t)).toBe(
      "mentions 10 = agreed 5 + explained by a rule 5 (call site 1, longer id 1, letters only 1, long line 1, code name 1) + known 0 + unexplained 0\nnot a mention, part of a longer word: 2",
    );
    expect(exitCode(t)).toBe(0);
    expect(oneLine(summary(t))).toBe(summary(t).split("\n").join("; "));
    expect(oneLine("a\nb\nc\n")).toBe("a; b; c; ");
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
    expect(t.mentions).toBe(3);
  });

  it("fails on a line darnit reports where the search reads no match as a mention", async () => {
    const dir = mkdtempSync(join(tmpdir(), "darnit-answer-key-alarms-"));
    try {
      writeFileSync(
        join(dir, "probe.md"),
        ["We use gpt-4o now.", "Deployment my_gpt-4 is ours.", "Ask the ada team.", 'Ask "ada" here.', ""].join("\n"),
      );
      writeFileSync(join(dir, "probe.py"), "x = o1 + 1\n");
      // What a darnit without its word, letters-only and code-name skips would report.
      const at = (file: string, line: number, model: string) => ({ id: "x", file, line, model });
      const mentions = [
        at("probe.md", 1, "gpt-4"),
        at("probe.md", 2, "gpt-4"),
        at("probe.md", 3, "ada"),
        at("probe.md", 4, "ada"),
        at("probe.py", 1, "o1"),
      ];
      const t = await answerKey(
        dir,
        { scanned: { files: 1, records: 0 }, hits: [], possiblyAffected: [], mentions },
        ids,
      );
      expect(misses(t).sort()).toEqual([
        "probe.md:1 gpt-4 only in darnit",
        "probe.md:2 gpt-4 only in darnit",
        "probe.md:3 ada only in darnit",
        "probe.py:1 o1 only in darnit",
      ]);
      expect([t.agreed, t.mentions, exitCode(t)]).toEqual([1, 5, 1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("explains a call site line only for the models darnit finds in that call's code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "darnit-answer-key-call-"));
    try {
      writeFileSync(
        join(dir, "app.py"),
        'from openai import OpenAI\nclient = OpenAI()\nclient.chat.completions.create(model="gpt-4-32k", messages=[])  # see gpt-4 docs\n',
      );
      const found = await checkReport(dir);
      const r: Report = {
        scanned: found.coverage,
        hits: toJson(found.hits) as Report["hits"],
        possiblyAffected: [],
        mentions: mentionsToJson(found.mentions),
      };
      expect((await answerKey(dir, r, ids)).explained).toEqual({ "call site": 1 });
      // Dropped from the report, the gpt-4 in the comment is not in the call's code, so the call site rule cannot explain it.
      const t = await answerKey(dir, { ...r, mentions: [] }, ids);
      expect(misses(t)).toEqual(["app.py:3 gpt-4 only in search"]);
      expect(t.explained).toEqual({ "call site": 1 });
      // Nor when the call's code holds gpt-4, as the record behind this call does not name it.
      const wide = { ...r.hits[0]!, text: 'create(model="gpt-4-32k", messages=[])  # see gpt-4 docs' };
      expect(ids.get(wide.id)?.has("gpt-4")).toBe(false);
      expect(misses(await answerKey(dir, { ...r, hits: [wide], mentions: [] }, ids))).toEqual([
        "app.py:3 gpt-4 only in search",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("agrees with darnit on each line a guard in the rules decides", async () => {
    const dir = mkdtempSync(join(tmpdir(), "darnit-answer-key-guards-"));
    try {
      const write = (file: string, lines: string[]) => writeFileSync(join(dir, file), [...lines, ""].join("\n"));
      // A dot then a digit joins the word; gpt-4 is no code name, even on a long line; o1 outside code files is a mention.
      write("notes.md", [
        "gpt-4.9 is not a model.",
        `${"x ".repeat(2600)}gpt-4 here`,
        "x = o1 + 1",
        'Ask the ada team, or "ada".',
      ]);
      // Inside a string or comment opened on an earlier line, o1 is a mention; after a closed comment it is code.
      write("doc.py", ['"""', "o1 runs here", '"""', "'''", "o1 runs here", "'''"]);
      write("doc.js", ["const s = `", "o1 runs here", "`;", "/*", "o1 runs here", "*/", "/* note */", "x = o1 + 1;"]);
      // A model on the second line of a call darnit reports.
      write("call.js", [
        'import OpenAI from "openai";',
        "const client = new OpenAI();",
        "await client.chat.completions.create({",
        "  model:",
        '    "gpt-4-32k",',
        "  messages: [],",
        "});",
      ]);
      writeFileSync(join(dir, "blob.bin"), "\0gpt-4 in a binary file\n");
      const found = await checkReport(dir);
      const r: Report = {
        scanned: found.coverage,
        hits: toJson(found.hits) as Report["hits"],
        possiblyAffected: toJson(found.values) as Report["possiblyAffected"],
        mentions: mentionsToJson(found.mentions),
      };
      const t = await answerKey(dir, r, ids);
      expect(misses(t)).toEqual([]);
      expect(summary(t)).toBe(
        "mentions 9 = agreed 7 + explained by a rule 2 (call site 1, code name 1) + known 0 + unexplained 0\nnot a mention, part of a longer word: 2",
      );
      // One match explained does not cover another match of the same id on that line that is a mention.
      const dropped = await answerKey(
        dir,
        { ...r, mentions: r.mentions.filter((m) => !(m.file === "notes.md" && m.line === 4)) },
        ids,
      );
      expect(misses(dropped)).toEqual(["notes.md:4 ada only in search"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a run darnit failed or ran with fewer records, and a known line for a repository it does not compare", () => {
    const report = { scanned: { files: 1, records: 3 }, hits: [], possiblyAffected: [], mentions: [] };
    expect(notComparable("a/b", { exit: 0, report }, 3)).toBeUndefined();
    expect(notComparable("a/b", { exit: 0, report }, 4)).toBe("darnit checked a/b against 3 records, not all 4");
    expect(notComparable("a/b", { error: "darnit exited 2 on a/b" }, 3)).toBe("darnit exited 2 on a/b");
    const known = parseKnown(
      "repo\tfile\tline\tid\tside\treason\na/b\ta.js\t1\to1\tsearch\tdarnit is right here\nc/d\ta.js\t1\to1\tsearch\tdarnit is right here\n",
    );
    expect(unlisted(known, [{ repo: "a/b" }])).toEqual([
      "test/answer-key/known.tsv lists c/d, which is not in repos.tsv",
    ]);
  });

  it("counts a listed difference as known, and fails on a listed one no longer seen or an unlisted one", () => {
    const miss = (line: number) => ({ file: "a.js", line, id: "o1", side: "search" as const });
    const known = parseKnown(
      "repo\tfile\tline\tid\tside\treason\na/b\ta.js\t1\to1\tsearch\to1 is a variable in minified code; darnit is right\n",
    );
    const t = { ...tally(), mentions: 1, unexplained: [miss(1)] };
    expect(applyKnown("a/b", t, known)).toEqual([]);
    expect([t.known, t.unexplained.length, exitCode(t)]).toEqual([1, 0, 0]);
    expect(summary(t)).toContain("+ known 1 + unexplained 0");

    const moved = { ...tally(), mentions: 1, unexplained: [miss(2)] };
    const stale = applyKnown("a/b", moved, known);
    expect(stale).toEqual([
      "a/b a.js:1 o1 only in search is in test/answer-key/known.tsv but no longer differs: remove that line",
    ]);
    expect(misses(moved)).toEqual(["a.js:2 o1 only in search"]);
    expect(exitCode(moved, stale)).toBe(1);
    expect(exitCode({ ...moved, unexplained: [] }, stale)).toBe(1);
    // Listed for another repository: still unexplained here.
    const other = { ...tally(), unexplained: [miss(1)] };
    expect(applyKnown("c/d", other, known)).toEqual([]);
    expect(exitCode(other)).toBe(1);
  });

  it("rejects a known line with a missing reason, a bad side or a repeat, and reads the stored list", () => {
    const head = "repo\tfile\tline\tid\tside\treason\n";
    expect(() => parseKnown(`${head}a/b\ta.js\t1\to1\tsearch\t \n`)).toThrow("line 2");
    expect(() => parseKnown(`${head}a/b\ta.js\t1\to1\tboth\twhy not\n`)).toThrow("line 2");
    expect(() => parseKnown(`${head}a/b\ta.js\t1\to1\tsearch\twhy\na/b\ta.js\t1\to1\tsearch\twhy\n`)).toThrow(
      "repeats",
    );
    const stored = parseKnown(readFileSync("test/answer-key/known.tsv", "utf8"));
    const repos = readFileSync("test/golden/repos.tsv", "utf8")
      .split("\n")
      .map((l) => l.split("\t")[0]);
    expect(stored.every((k) => repos.includes(k.repo))).toBe(true);
  });

  it("reads a crafted file full of ids in linear time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "darnit-answer-key-crafted-"));
    try {
      writeFileSync(join(dir, "a.py"), "x = o1 + ada\n".repeat(200_000));
      const started = performance.now();
      const t = await answerKey(
        dir,
        { scanned: { files: 1, records: 0 }, hits: [], possiblyAffected: [], mentions: [] },
        ids,
      );
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(t.explained).toEqual({ "code name": 200_000, "letters only": 200_000 });
      expect(t.unexplained).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
