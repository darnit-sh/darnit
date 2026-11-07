import { describe, expect, it } from "vitest";
import { settingsOf } from "../src/corpus/candidates.js";
import { cellModels, readPage } from "../src/corpus/replacements.js";
import { ModelId, parseChangeRecord, type ChangeRecord } from "../src/records/schema.js";
import { slowdown } from "./helpers.js";

// The corpus regexes as they were before each became linear: every rewrite must read exactly what these read.
const OLD = {
  list: /\s*[|,]\s*/,
  prose: /,\s*|\s+and\s+/,
  important: /\s*!\s*important$/,
  setting: /["']?([A-Za-z_]\w*)["']?\s*[:=]\s*(\$|"([^"]*)"|'([^']*)')?/g,
};

const isModel = (s: string) => ModelId.safeParse(s).success;
const BASE = parseChangeRecord(
  {
    id: "openai:2026-01-01:x",
    status: "candidate",
    vendor: "openai",
    announcedAt: "2026-01-01",
    kind: "deprecation",
    surface: { sdkSymbols: ["responses.create"], fields: ["model"] },
    classification: "semantic",
    sources: [{ url: "https://example.com/spec" }],
    detection: { astGrepPatterns: { js: [{ context: "f(x)", selector: "call_expression" }] } },
  },
  "x.json",
);
const withContext = (context: string): ChangeRecord => ({
  ...BASE,
  detection: { astGrepPatterns: { js: [{ context, selector: "call_expression" }] } },
});
/** The tables a page shows when one sits in a div with `style`. */
const shown = (style: string) => readPage(`<div style="${style}"><table></table></div>`).tables.length;

/** Every string of up to `length` tokens. */
function strings(tokens: string[], length: number): string[] {
  let level = [""];
  const out = [""];
  for (let i = 0; i < length; i++) {
    level = level.flatMap((s) => tokens.map((t) => s + t));
    out.push(...level);
  }
  return out;
}

// What each regex read before the rewrite: the parts of a model cell, of the prose in its parentheses, a style value
// without "!important", and the keys a pattern sets.
const listed = (text: string) => {
  const parts = text.split(OLD.list);
  return parts.every(isModel) ? parts : undefined;
};
const prose = (inner: string) => {
  const parts = inner.split(OLD.prose);
  return parts.every(isModel) ? ["gpt-4o", ...parts] : undefined;
};
const hidden = (value: string) => value.trim().toLowerCase().replace(OLD.important, "") === "none";
const settings = (context: string) =>
  [...context.matchAll(OLD.setting)].map((m) => ({ key: m[1], any: m[2] === "$", value: m[3] ?? m[4] }));

describe("the corpus regexes read what they read before", () => {
  it.each([
    ["a-1 | b-1", ["a-1", "b-1"]],
    ["a-1 ,b-1", ["a-1", "b-1"]],
    ["a-1 | | b-1", undefined],
    ["a-1\t\u00a0| b-1", ["a-1", "b-1"]],
    [" a-1|b-1", undefined],
    ["a-1 b-1", undefined],
    ["a-1 |", undefined],
  ])("splits the model cell %j as before", (text, expected) => {
    expect([listed(text), cellModels(text)]).toEqual([expected, expected]);
  });

  it.each([
    ["a-1, b-1", ["gpt-4o", "a-1", "b-1"]],
    ["a-1 and b-1", ["gpt-4o", "a-1", "b-1"]],
    ["a-1\u00a0 and\tb-1", ["gpt-4o", "a-1", "b-1"]],
    ["a-1 , b-1", undefined],
    ["a-1, and b-1", undefined],
    ["a-1 andb-1", undefined],
  ])("splits the prose %j as before", (inner, expected) => {
    expect([prose(inner), cellModels(`GPT-4o (${inner})`)]).toEqual([expected, expected]);
  });

  it.each([
    ["none !important", 0],
    ["none\t!\nimportant", 0],
    ["none!important", 0],
    ["none ! important x", 1],
    ["!important", 1],
    ["none !importantx", 1],
    ["none !! important", 1],
  ])("reads display: %j as before", (value, tables) => {
    expect([hidden(value) ? 0 : 1, shown(`display:${value}`)]).toEqual([tables, tables]);
  });

  it.each([
    ['({ model: "a" })', [{ key: "model", any: false, value: "a" }]],
    ["f(n_1=$V)", [{ key: "n_1", any: true, value: undefined }]],
    ['{"9abc": 1}', [{ key: "abc", any: false, value: undefined }]],
    [
      "f(a9b = 'x', c=1)",
      [
        { key: "a9b", any: false, value: "x" },
        { key: "c", any: false, value: undefined },
      ],
    ],
    ['a: "b: 1"', [{ key: "a", any: false, value: "b: 1" }]],
    ["ab cd", []],
  ])("reads the keys of %j as before", (context, expected) => {
    expect([settings(context), settingsOf(withContext(context))]).toEqual([expected, expected]);
  });

  it("agrees with the old regexes on every short string of the characters they turn on", () => {
    for (const text of strings(["a-1", " ", "\u00a0", "\t", "|", ","], 5))
      expect([text, cellModels(text)]).toEqual([text, listed(text)]);
    for (const inner of strings(["a-1", " ", "\u00a0", ",", "and", "x"], 5))
      expect([inner, cellModels(`GPT-4o (${inner})`)]).toEqual([inner, prose(inner)]);
    for (const value of strings([" ", "\t", "!", "important", "none", "x"], 4))
      expect([value, shown(`display:${value}`)]).toEqual([value, hidden(value) ? 0 : 1]);
    for (const context of strings(['"', "'", "a", "_", "9", ":", "=", " ", "$", "-"], 4))
      expect([context, settingsOf(withContext(context))]).toEqual([context, settings(context)]);
  });
});

describe("the corpus regexes take linear time on crafted text", () => {
  // Each against text of the same length whose runs are one character long, so it does the same work once.
  const short = (n: number) => " a".repeat(n / 2);

  it("reads a page whose style attribute holds 160,000 spaces outside any table", { tags: ["cpu-time"] }, async () => {
    // Quadratic before: 11 seconds, where the same page with one-space runs takes milliseconds.
    const page = (style: string) => `<div style="display:${style}">x</div><table></table>`;
    const crafted = page(`a${" ".repeat(160_000)}x`);
    expect(readPage(crafted).tables).toHaveLength(1);
    expect(
      await slowdown(
        () => readPage(crafted),
        () => readPage(page(short(160_000))),
        5,
      ),
    ).toBeLessThan(5);
  });

  it("reads a model cell holding a long run of no-break spaces", { tags: ["cpu-time"] }, async () => {
    const run = "\u00a0".repeat(100_000);
    for (const cell of [`a-1${run}x`, `GPT-4o (a-1${run},x)`]) {
      expect(cellModels(cell)).toBeUndefined();
      const same = cell.replace(run, short(100_000));
      expect(
        await slowdown(
          () => cellModels(cell),
          () => cellModels(same),
          5,
        ),
      ).toBeLessThan(5);
    }
  });

  it("reads the keys of a pattern holding a long word", { tags: ["cpu-time"] }, async () => {
    // A fresh record each run, as settingsOf keeps what it read of one.
    const keys = (context: string) => () => settingsOf(withContext(context));
    const word = `f(${"a".repeat(100_000)})`;
    expect(keys(word)()).toEqual([]);
    expect(await slowdown(keys(word), keys(`f(${short(100_000)})`), 5)).toBeLessThan(5);
  });
});
