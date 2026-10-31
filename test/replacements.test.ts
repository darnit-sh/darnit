import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { cellModels, cellText, pageMismatches, readPage, recommended, replacementsFor } from "../src/corpus/replacements.js";
import { loadRecords } from "../src/records/load.js";
import { parseChangeRecord, recordModels, type ChangeRecord } from "../src/records/schema.js";

const PAGE = "https://developers.openai.com/api/docs/deprecations";
const notes = (pairs: string) => `OpenAI removes these models. Recommended replacements: ${pairs}. A newer model can answer differently, so test the switch.`;
// Real rows from OpenAI's deprecations page, trimmed to its tables.
const FIXTURE = readFile(new URL("./fixtures/deprecations.html", import.meta.url), "utf8");

/** A shutdown record detecting `models`, with `pairs` as the replacements its notes name. */
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
      sources: [{ url: PAGE }],
      notes: { migration: pairs === undefined ? "OpenAI names no replacement. A newer model can answer differently." : notes(pairs) },
      detection: { astGrepPatterns: { js: models.map((m) => ({ context: `({ model: "${m}" })`, selector: "pair" })) } },
    },
    `${slug}.json`,
  );
}

/** A page with one table of `rows`, each "model cell || replacement cell". */
const table = (rows: string[], head = "<th>Shutdown date</th><th>Model / system</th><th>Recommended replacement</th>") =>
  `<table><thead><tr>${head}</tr></thead><tbody>${rows.map((r) => `<tr> <td>2026</td> ${r.split(" || ").map((c) => `<td>${c}</td>`).join(" ")} </tr>`).join("\n")}</tbody></table>`;

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

describe("the deprecations page", () => {
  it("reads every model in a model cell: a snapshot and its aliases, a family and its snapshots, or prose naming them", () => {
    expect(cellModels("gpt-5.3-codex")).toEqual(["gpt-5.3-codex"]);
    expect(cellModels("gpt-4-0613 | gpt-4, gpt-4-0613-completions, gpt-4-completions")).toEqual(["gpt-4-0613", "gpt-4", "gpt-4-0613-completions", "gpt-4-completions"]);
    expect(cellModels("GPT-4o (gpt-4o-2024-08-06, gpt-4o-2024-11-20)")).toEqual(["gpt-4o", "gpt-4o-2024-08-06", "gpt-4o-2024-11-20"]);
    expect(cellModels("GPT-4o mini (gpt-4o-mini-2024-07-18)")).toEqual(["gpt-4o-mini", "gpt-4o-mini-2024-07-18"]);
    expect(cellModels("gpt-4-0125-preview (including gpt-4-turbo-preview and gpt-4-turbo-preview-completions, which point to this snapshot)")).toEqual([
      "gpt-4-0125-preview",
      "gpt-4-turbo-preview",
      "gpt-4-turbo-preview-completions",
    ]);
    for (const other of ["/v1/audio/translations", "Videos API", "OpenAI-Beta: realtime=v1", "New fine-tuning training on babbage-002", "Assistants API (v1, v2 and more)", ""])
      expect(cellModels(other)).toBeUndefined();
  });

  it("reads each header shape and lists every row and table it does not read as models", async () => {
    const { replacements, skipped } = readPage(await FIXTURE);
    const at = (m: string) => replacements.get(m);
    expect(at("gpt-6-luna")).toBeUndefined();
    expect(at("gpt-4o-2024-11-20")).toEqual(["gpt-6-luna"]); // a family with its snapshots
    expect(at("gpt-5")).toEqual(["gpt-5.6-sol"]); // a snapshot with its alias
    expect(at("gpt-5-pro")).toEqual(["gpt-5.6-sol (reasoning.mode: pro)"]); // a setting in parentheses
    expect(at("gpt-4o-mini-transcribe-2025-03-20")).toEqual(["gpt-4o-mini-transcribe-2025-12-15"]); // "Model family / snapshot"
    expect(at("gpt-3.5-turbo-completions")).toEqual(["gpt-5.6-terra"]); // "Substitute model"
    expect(at("gpt-4-turbo-preview-completions")).toEqual(["gpt-5 or gpt-4.1*"]); // prose, a date with non-breaking hyphens
    expect(at("sora-2")).toEqual(["—"]);
    expect(at("gpt-4-32k")).toEqual(["gpt-4o"]); // one price column
    expect(at("davinci")).toEqual(["davinci-002", "davinci-002, gpt-3.5-turbo, gpt-4o"]); // two price columns, newest first
    expect(at("gpt-4-0314")).toEqual(["gpt-5 or gpt-4.1*", "gpt-4o"]); // "Legacy model"
    expect(at("code-cushman-001")).toEqual(["gpt-4o"]); // "Deprecated model" with no price
    expect(at("gpt-5.4-cyber")).toEqual(["The most capable cyber model available to you."]);
    expect(skipped).toHaveLength(13);
    expect(skipped.filter((s) => !s.startsWith("row "))).toEqual([]);
    expect(skipped).toContain("row 2024-10-28 | New fine-tuning training on babbage-002 | gpt-4o-mini");
    expect(skipped).toContain("row 2022-12-03 | /v1/search | View transition guide");
  });

  it("reads the page as text: inline tags skipped, entities decoded once, other tables and short rows listed", () => {
    const { replacements, skipped } = readPage(
      [
        table(["<code>a&#45;1</code> | <span class=\"x\">a&#x2D;2</span> || <code>b&amp;1</code>", "a\u20113 || <b>b-1</b><br/>"]),
        table(["x-1 || y-1"], "<th>Date</th><th>Model</th><th>Recommended replacement</th>"),
        table(["x-2 || $1 || y-1"]),
      ].join(""),
    );
    expect(replacements).toEqual(new Map([["a-3", ["b-1"]]]));
    expect(skipped).toEqual(["row 2026 | a-1 | a&#x2D;2 | b&1", "table headed Date | Model | Recommended replacement", "row 2026 | x-2 | $1 | y-1"]);
  });

  it("refuses a cell holding markup, a control or bidi character, or a megabyte, and never cleans it up", () => {
    const hostile = [
      "&lt;script&gt;alert(1)&lt;/script&gt;",
      "<scr<script>ipt>alert(1)</script>",
      "&#60;script&#62;",
      "<img src=x onerror=alert(1)>gpt-5",
      "gpt-5<!-- x -->",
      "gpt-5 <code",
      "gpt-5\u202e",
      "gpt-5\u0007",
      `gpt-5${" ".repeat(1_000_000)}`,
    ];
    for (const cell of hostile) {
      expect(cellText(cell)).toBeUndefined();
      const page = readPage(table([`a-1 || ${cell}`, `${cell} || b-1`]));
      expect(page.replacements).toEqual(new Map());
      expect(page.skipped).toEqual(Array(2).fill("row refused: a cell holds markup, control characters or over 10000 characters"));
    }
    // Decoded once: the entities stay text, and the cell gets darnit's fixed words, never its own.
    expect(cellText("&amp;lt;script&amp;gt;")).toBe("&lt;script&gt;");
  });

  it("keeps no page text in fix.models: only model ids, one plain setting, or darnit's own words", () => {
    const r = shutdown("one", ["a-1", "a-2", "a-3", "a-4", "a-5", "a-6", "a-7"]);
    const page = readPage(
      table([
        "a-1 || &amp;lt;script&amp;gt;",
        "a-2 || The most capable model available to you.",
        "a-3 || x-1 (see the <a href=\"/guide\">guide</a>)",
        "a-4 || x-1 (mode: \"pro\")",
        "a-5 || x-1 or gpt-4.1*",
        "a-6 || x-1, y-1, or z-1",
        "a-7 || View transition guide",
      ]),
    );
    const none = { human: "OpenAI names no single replacement model", source: PAGE };
    expect(replacementsFor([r], page).models.get(r.id)).toEqual({
      "a-1": none,
      "a-2": none,
      "a-3": { human: "not a plain swap: OpenAI recommends x-1 with see the guide", source: PAGE },
      "a-4": none,
      "a-5": none,
      "a-6": { human: "not a plain swap: OpenAI recommends one of x-1, y-1, z-1", source: PAGE },
      "a-7": none,
    });
  });
});

describe("fix.models from the page", () => {
  it("maps every model a record detects, aliases included, to a rename or a reason a person reads", () => {
    const r = shutdown("one", ["a-1", "a", "b-1", "c-1", "d-1", "e-1"]);
    const page = readPage(table(["a-1 | a || x-1", "b-1 || <code>x-1</code> (<code>reasoning.mode: pro</code>)", "c-1 || x-1 or y-1", "d-1 || gpt-4.1*", "e-1 || —"]));
    expect(replacementsFor([r], page)).toEqual({
      models: new Map([
        [
          r.id,
          {
            "a-1": { model: "x-1", source: PAGE },
            a: { model: "x-1", source: PAGE },
            "b-1": { human: "not a plain swap: OpenAI recommends x-1 with reasoning.mode: pro", source: PAGE },
            "c-1": { human: "not a plain swap: OpenAI recommends one of x-1, y-1", source: PAGE },
            "d-1": { human: "OpenAI names no single replacement model", source: PAGE },
            "e-1": { human: "OpenAI names no replacement", source: PAGE },
          },
        ],
      ]),
      problems: [],
    });
  });

  it("follows a replacement the page retires too, to one it does not, or asks a person", () => {
    const r = shutdown("one", ["a-1", "a-2", "a-3"]);
    const page = readPage(table(["a-1 || b-1", "b-1 | b || c-1", "c-1 || d-1", "a-2 || b-2", "b-2 || x-1 or y-1", "a-3 || c-3", "c-3 || c-4", "c-4 || c-3"]));
    expect(replacementsFor([r], page).models.get(r.id)).toEqual({
      "a-1": { model: "d-1", source: PAGE },
      "a-2": { human: "OpenAI recommends b-2, which also shuts down; not a plain swap: OpenAI recommends one of x-1, y-1", source: PAGE },
      "a-3": { human: "the recommended replacements loop back to c-3", source: PAGE },
    });
  });

  it("fails on a detected model the page has no row for, and on notes that disagree with the page", () => {
    const page = readPage(table(["a-1 || b-1", "a-2 || b-2"]));
    expect(replacementsFor([shutdown("one", ["a-1", "z-1"])], page)).toEqual({ models: new Map(), problems: ["openai:2026-01-01:one: the page has no row for z-1"] });
    expect(pageMismatches([shutdown("ok", ["a-1", "a-2"], "a-1 to b-1")], page)).toEqual([]);
    expect(pageMismatches([shutdown("bad", ["a-1", "a-2"], "a-1 to z-1; a-2 to b-2; q-1 to b-1")], page)).toEqual([
      "openai:2026-01-01:bad: notes say a-1 to z-1, the page says b-1",
      "openai:2026-01-01:bad: the notes name q-1, which the record does not detect",
    ]);
  });

  it("gives every shipped model record what the page gives, agreeing with its notes, and never a retiring replacement", async () => {
    const records = (await loadRecords()).map((l) => l.record);
    const page = readPage(await FIXTURE);
    const { models, problems } = replacementsFor(records, page);
    expect(problems).toEqual([]);
    expect(pageMismatches(records, page)).toEqual([]);
    const shipped = records.filter((r) => recordModels(r).length > 0);
    expect(shipped).toHaveLength(29);
    expect(shipped.filter((r) => JSON.stringify(r.fix?.models) !== JSON.stringify(models.get(r.id))).map((r) => r.id)).toEqual([]);
    const swaps = new Map(shipped.flatMap((r) => Object.entries(r.fix!.models!)));
    const retiring = new Set([...records.flatMap(recordModels), ...page.replacements.keys()]);
    expect([...swaps.values()].flatMap((s) => ("model" in s && retiring.has(s.model) ? [s.model] : []))).toEqual([]);
    // Every reason is darnit's own words around model ids and one plain setting.
    const ID = "[a-z0-9][a-z0-9._:-]*";
    const built = new RegExp(`^(OpenAI recommends ${ID}, which also shuts down; )?(OpenAI names no replacement|OpenAI names no single replacement model|not a plain swap: OpenAI recommends (one of ${ID}(, ${ID})+|${ID} with [A-Za-z0-9._: -]+))$`);
    expect([...swaps.values()].flatMap((s) => ("human" in s && !built.test(s.human) ? [s.human] : []))).toEqual([]);
    expect(Object.fromEntries(["gpt-4", "gpt-3.5-turbo", "o1", "o3-mini", "o4-mini", "gpt-4.5-preview", "o1-mini", "o1-pro"].map((m) => [m, swaps.get(m)]))).toEqual({
      "gpt-4": { model: "gpt-5.6-sol", source: PAGE },
      "gpt-3.5-turbo": { model: "gpt-5.6-terra", source: PAGE },
      o1: { model: "gpt-5.6-sol", source: PAGE },
      "o3-mini": { model: "gpt-5.6-sol", source: PAGE },
      "o4-mini": { model: "gpt-5.6-terra", source: PAGE },
      "gpt-4.5-preview": { model: "gpt-6-luna", source: PAGE }, // gpt-4.1, itself retiring
      "o1-mini": { model: "gpt-5.6-terra", source: PAGE }, // o4-mini, itself retiring
      "o1-pro": { human: "not a plain swap: OpenAI recommends gpt-5.6-sol with reasoning.mode: pro", source: PAGE },
    });
  });
});
