import { describe, expect, it } from "vitest";
import { pageMismatches, pageRows, recommended, replacementsFor } from "../src/corpus/replacements.js";
import { loadRecords } from "../src/records/load.js";
import { parseChangeRecord, recordModels, type ChangeRecord } from "../src/records/schema.js";

const URL = "https://developers.openai.com/api/docs/deprecations";
const notes = (pairs: string) => `OpenAI removes these models. Recommended replacements: ${pairs}. A newer model can answer differently, so test the switch.`;

/** A shutdown record detecting `models`, with `pairs` as its recommended replacements. */
function shutdown(slug: string, models: string[], pairs?: string): ChangeRecord {
  return parseChangeRecord(
    {
      id: `openai:2026-01-01:${slug}`,
      status: "parser-verified",
      vendor: "openai",
      announcedAt: "2026-01-01",
      kind: "deprecation",
      surface: { sdkSymbols: ["responses.create"], fields: ["model"] },
      classification: "semantic",
      sources: [{ url: URL }],
      notes: { migration: pairs === undefined ? "OpenAI names no replacement. A newer model can answer differently." : notes(pairs) },
      detection: { astGrepPatterns: { js: models.map((m) => ({ context: `({ model: "${m}" })`, selector: "pair" })) } },
    },
    `${slug}.json`,
  );
}

describe("recommended replacements in a record's notes", () => {
  it("reads each model and its replacement as written", () => {
    expect(recommended(notes("a-1 to b-1; c-1 to b-1 (reasoning.mode: pro); d-1 to The most capable model available to you."))).toEqual(
      new Map([
        ["a-1", "b-1"],
        ["c-1", "b-1 (reasoning.mode: pro)"],
        ["d-1", "The most capable model available to you."],
      ]),
    );
    expect(recommended("OpenAI names no replacement.")).toEqual(new Map());
  });

  it("refuses notes it cannot read whole, rather than dropping a model", () => {
    expect(() => recommended(notes("a-1 to b-1; a-1 to c-1"))).toThrow(/a-1 is named twice/);
    expect(() => recommended(notes("a-1 to b-1; c-1, b-1"))).toThrow(/cannot read "c-1, b-1"/);
    expect(() => recommended("Recommended replacements: a-1 to b-1. Test it.")).toThrow(/do not end/);
  });
});

describe("fix.models from the notes", () => {
  it("maps a plain rename to the model and anything else to a reason a person reads", () => {
    const r = shutdown("one", ["a-1", "b-1", "c-1", "d-1", "e-1"], "a-1 to x-1; b-1 to x-1 (reasoning.mode: pro); c-1 to x-1 or y-1; d-1 to gpt-4.1*");
    expect(replacementsFor([r]).get(r.id)).toEqual({
      "a-1": { model: "x-1", source: URL },
      "b-1": { human: "not a plain swap: OpenAI recommends x-1 (reasoning.mode: pro)" },
      "c-1": { human: "not a plain swap: OpenAI recommends x-1 or y-1" },
      "d-1": { human: "not a plain swap: OpenAI recommends gpt-4.1*" },
      "e-1": { human: "OpenAI names no replacement" },
    });
  });

  it("follows a replacement another record retires to one no record retires", () => {
    const old = shutdown("old", ["a-1"], "a-1 to b-1");
    const mid = shutdown("mid", ["b-1"], "b-1 to c-1");
    const last = shutdown("last", ["c-1"], "c-1 to d-1");
    expect(replacementsFor([old, mid, last]).get(old.id)).toEqual({ "a-1": { model: "d-1", source: URL } });
  });

  it("asks a person when the replacement is retiring with no plain swap, or the chain loops", () => {
    const old = shutdown("old", ["a-1", "a-2"], "a-1 to b-1; a-2 to c-1");
    const none = shutdown("none", ["b-1"]);
    const loop = shutdown("loop", ["c-1", "c-2"], "c-1 to c-2; c-2 to c-1");
    expect(replacementsFor([old, none, loop]).get(old.id)).toEqual({
      "a-1": { human: "b-1, the recommended replacement, also shuts down: OpenAI names no replacement" },
      "a-2": { human: "the recommended replacements loop back to c-1" },
    });
  });

  it("fails on notes naming a model the record does not detect", () => {
    expect(() => replacementsFor([shutdown("one", ["a-1"], "a-1 to b-1; z-1 to b-1")])).toThrow(/name z-1, which the record does not detect/);
  });

  it("gives every shipped model record exactly what its notes give, and never a model another record retires", async () => {
    const records = (await loadRecords()).map((l) => l.record);
    const models = records.filter((r) => recordModels(r).length > 0);
    expect(models).toHaveLength(29);
    const wanted = replacementsFor(records);
    expect(models.filter((r) => JSON.stringify(r.fix?.models) !== JSON.stringify(wanted.get(r.id))).map((r) => r.id)).toEqual([]);
    const retired = new Set(records.flatMap(recordModels));
    const swaps = models.flatMap((r) => Object.values(r.fix!.models!));
    expect(swaps.flatMap((s) => ("model" in s && retired.has(s.model) ? [s.model] : []))).toEqual([]);
    // Chains followed in the shipped data: text-ada-001 to gpt-3.5-turbo-instruct, itself retired, to gpt-5.6-terra.
    expect(records.find((r) => r.fix?.models?.["text-ada-001"])!.fix!.models!["text-ada-001"]).toEqual({ model: "gpt-5.6-terra", source: URL });
    expect(records.find((r) => r.fix?.models?.["o1-mini"])!.fix!.models!["o1-mini"]).toEqual({ human: "o4-mini, the recommended replacement, also shuts down: OpenAI names no replacement" });
  });
});

describe("the deprecations page cross-check", () => {
  const page = [
    "<table><tr><th>Shutdown date</th><th>Model / system</th><th>Recommended replacement</th></tr>",
    '<tr class="r"><td>2026-12-11</td><td><code>a-1</code></td><td><code>b-1</code></td></tr>',
    "<tr><td>2026-12-11</td><td>c-1</td><td>b-1 (reasoning.mode: pro)</td></tr>",
    "<tr><td>2026-12-11</td><td>d-1</td><td>&mdash;</td></tr>",
    "<tr><td>2026-12-11</td><td>e-1</td><td><script>alert(1)</script>x &amp; y</td></tr></table>",
  ].join("\n");

  it("reads each row's model and replacement as text", () => {
    expect(pageRows(page).get("a-1")).toEqual(["b-1"]);
    expect(pageRows(page).get("c-1")).toEqual(["b-1 (reasoning.mode: pro)"]);
    expect(pageRows(page).get("e-1")).toEqual(["alert(1)x & y"]);
    expect(pageRows(page).get("d-1")).toEqual(["—"]);
    expect(pageRows("<tr><td>1</td><td>a&#45;1</td><td>b&#999999;&#1114112;</td></tr>").get("a-1")).toEqual(["b\u{f423f}&#1114112;"]);
  });

  it("agrees with notes that match, and names each disagreement", () => {
    const rows = pageRows(page);
    expect(pageMismatches([shutdown("ok", ["a-1", "c-1", "d-1"], "a-1 to b-1; c-1 to b-1 (reasoning.mode: pro)")], rows)).toEqual([]);
    expect(pageMismatches([shutdown("bad", ["a-1", "c-1", "f-1"], "a-1 to z-1; f-1 to b-1")], rows)).toEqual([
      "openai:2026-01-01:bad: notes say a-1 to z-1, the page says b-1",
      "openai:2026-01-01:bad: the page says c-1 to b-1 (reasoning.mode: pro), the notes name none",
      "openai:2026-01-01:bad: notes say f-1 to b-1, the page says nothing",
    ]);
  });
});
