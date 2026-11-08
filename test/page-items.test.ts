import { describe, expect, it } from "vitest";
import { account } from "../src/corpus/accounting.js";
import { pageItems, pageDisagreements } from "../src/corpus/page-rows.js";
import { modelDetection, modelNotes, readPage } from "../src/corpus/replacements.js";
import { parseChangeRecord, type ChangeRecord } from "../src/records/schema.js";

// Each test builds its own small page and records; nothing here reads the committed corpus or packs.
const PAGE = "https://example.com/deprecations";
// No model is listed in the API spec here, so the page's replacement is for a person.
const HUMAN = "not a plain swap: OpenAI recommends zzq-new, which its API spec does not list";
const SPEC = { openapi: "3.1.0", paths: {} };

const table = (rows: [string, string, string][]) =>
  readPage(
    `<table><tr><th>Shutdown date</th><th>Model</th><th>Recommended replacement</th></tr>${rows
      .map(([date, m, to]) => `<tr><td>${date}</td><td>${m}</td><td>${to}</td></tr>`)
      .join("")}</table>`,
  );

/** A model record shutting down on 2027-03-01, with the page's notes and replacement unless given others. */
function record(model: string, change: { replacement?: object; replacedBy?: string; vendor?: string } = {}) {
  const page = table([["2027-03-01", model, change.replacedBy ?? "zzq-new"]]);
  return parseChangeRecord(
    {
      id: `${change.vendor ?? "openai"}:2026-11-01:${model}-shut-down`,
      title: `${model} shut down on 2027-03-01`,
      status: "candidate",
      vendor: change.vendor ?? "openai",
      announcedAt: "2026-11-01",
      effectiveAt: "2027-03-01",
      kind: "breaking",
      surface: { endpoints: ["/v1/chat/completions"], sdkSymbols: ["chat.completions.create"], fields: ["model"] },
      classification: "semantic",
      sources: [{ url: PAGE }],
      notes: { migration: modelNotes("OpenAI", [model], "2027-03-01", page) },
      detection: modelDetection([model]),
      fix: { models: { [model]: change.replacement ?? { human: HUMAN, source: PAGE } } },
    },
    "test",
  );
}

const lists = { known: new Set<string>(), notModels: new Set<string>(), wholeDates: new Set<string>() };

describe("pageItems", () => {
  it("keys each shutdown date and model once, with the vendor's records that detect the model", () => {
    const page = table([
      ["2027-03-01", "zzq-one | zzq-one-2026-01-01", "zzq-new"],
      ["2027-03-01", "zzq-one", "zzq-new"],
      ["2027-04-01", "zzq-one", "zzq-new"],
      ["soon", "zzq-two", "zzq-new"],
    ]);
    const records = [record("zzq-one"), record("zzq-one", { vendor: "other" })];
    expect(pageItems(page, records, "openai")).toEqual([
      { key: "page 2027-03-01 zzq-one", ids: ["openai:2026-11-01:zzq-one-shut-down"] },
      { key: "page 2027-03-01 zzq-one-2026-01-01", ids: [] },
      { key: "page 2027-04-01 zzq-one", ids: ["openai:2026-11-01:zzq-one-shut-down"] },
      { key: "page no date read zzq-two", ids: [] },
    ]);
  });

  it("keeps every other row of every table as an item no record detects, keyed by all of it", () => {
    const shutdowns = table([
      ["2027-03-01", "Assistants API", "Responses API"],
      ["2027-03-01", "zzq-a and zzq-b", "zzq-new"],
      ["2027-03-01", "zzq-c (1M context)", "zzq-new"],
      ["2024-10-28", "New fine-tuning training on zzq-one", "zzq-new"],
    ]);
    const records = [record("zzq-one")];
    expect(pageItems(shutdowns, records, "openai")).toEqual([
      { key: "page 2027-03-01 Assistants API | Responses API", ids: [] },
      { key: "page 2027-03-01 zzq-a and zzq-b | zzq-new", ids: [] },
      { key: "page 2027-03-01 zzq-c (1M context) | zzq-new", ids: [] },
      { key: "page 2024-10-28 New fine-tuning training on zzq-one | zzq-new", ids: [] },
    ]);
    // Rows alike up to their last cell are two items, so an entry for one never stands for the other.
    const endpoints = readPage(
      "<table><tr><th>Shutdown date</th><th>Endpoint</th><th>Model</th></tr><tr><td>2027-03-01</td><td>/v1/zzq</td><td>zzq-a</td></tr><tr><td>2027-03-01</td><td>/v1/zzq</td><td>zzq-b</td></tr></table>",
    );
    expect(pageItems(endpoints, records, "openai")).toEqual([
      { key: "page 2027-03-01 /v1/zzq | zzq-a", ids: [] },
      { key: "page 2027-03-01 /v1/zzq | zzq-b", ids: [] },
    ]);
  });

  it("trusts no header: a row under any header gives an item, and only a first row with no date is left out", () => {
    const records = [record("zzq-one")];
    // A no-break space, a note mark, another name, a dated update, and a title row above the header.
    const rows = "<tr><td>2027-03-01</td><td>zzq-a</td><td>zzq-new</td></tr>";
    for (const head of [
      "<th>Shutdown&nbsp;date</th><th>Model</th><th>Recommended replacement</th>",
      "<th>Shutdown date*</th><th>Model</th><th>Recommended replacement</th>",
      "<th>Retirement date</th><th>Model</th><th>Recommended replacement</th>",
      "<th>Date</th><th>Update</th><th>Note</th>",
      "<th>Models</th></tr><tr><th>Shutdown date</th><th>Model</th><th>Recommended replacement</th>",
    ]) {
      const page = readPage(`<table><tr>${head}</tr>${rows}</table>`);
      expect(pageItems(page, records, "openai"), head).toContainEqual({
        key: "page 2027-03-01 zzq-a | zzq-new",
        ids: [],
      });
    }
    const modelFirst = readPage(
      "<table><tr><th>Model</th><th>Shutdown date</th></tr><tr><td>zzq-a</td><td>2027-03-01</td></tr><tr><td>zzq-b</td><td>2027-03-01</td></tr></table>",
    );
    expect(pageItems(modelFirst, records, "openai")).toEqual([
      { key: "page no date read zzq-a | 2027-03-01", ids: [] },
      { key: "page no date read zzq-b | 2027-03-01", ids: [] },
    ]);
    // No header row at all: the first row is a row like the others.
    const headless = readPage("<table><tr><td>2027-03-01</td><td>zzq-a</td><td>zzq-new</td></tr></table>");
    expect(pageItems(headless, records, "openai")).toEqual([{ key: "page 2027-03-01 zzq-a | zzq-new", ids: [] }]);
  });
});

describe("account with page models", () => {
  const run = (models: string[], records: ChangeRecord[], notCovered: Parameters<typeof account>[0]["notCovered"]) =>
    account({
      vendor: "openai",
      spec: SPEC,
      removals: [],
      records,
      notCovered,
      pageItems: pageItems(table(models.map((m) => ["2027-03-01", m, "zzq-new"])), records, "openai"),
    });

  it("holds a page model no record detects to an entry, like a spec item", () => {
    expect(run(["zzq-old"], [], []).unaccounted).toEqual(["page 2027-03-01 zzq-old"]);
    const listed = run(["zzq-old"], [], [{ items: ["page 2027-03-01 zzq-old"], "needs-record": "A record for it." }]);
    expect(listed.unaccounted).toEqual([]);
    expect(listed.needsRecord).toEqual([{ key: "page 2027-03-01 zzq-old", proposal: "A record for it." }]);
  });

  it("counts a page model a record detects as covered, and fails an entry for it or for one gone from the page", () => {
    const result = run(
      ["zzq-two"],
      [record("zzq-two")],
      [{ items: ["page 2027-03-01 zzq-two", "page 2027-03-01 zzq-gone"], reason: "Kept for the test." }],
    );
    expect(result.covered).toEqual(new Map([["page 2027-03-01 zzq-two", ["openai:2026-11-01:zzq-two-shut-down"]]]));
    expect(result.redundant).toEqual([
      { key: "page 2027-03-01 zzq-two", ids: ["openai:2026-11-01:zzq-two-shut-down"] },
    ]);
    expect(result.stale).toEqual(["page 2027-03-01 zzq-gone"]);
  });
});

describe("pageDisagreements", () => {
  const page = table([
    ["2027-03-01", "zzq-one", "zzq-new"],
    ["2027-03-01", "zzq-two", "zzq-new"],
  ]);

  it("passes records whose notes and replacements are what the page gives", () => {
    expect(pageDisagreements([record("zzq-one"), record("zzq-two")], page, lists)).toEqual([]);
  });

  it("names a record whose replacements or notes are not what the page gives", () => {
    const wrongFix = record("zzq-one", { replacement: { model: "zzq-other", source: PAGE } });
    const wrongNotes = record("zzq-two", { replacedBy: "zzq-older" });
    expect(pageDisagreements([wrongFix, wrongNotes], page, lists)).toEqual([
      "openai:2026-11-01:zzq-two-shut-down: notes say zzq-two to zzq-older, the page says zzq-new",
      "openai:2026-11-01:zzq-one-shut-down: its replacements are not what the page gives",
    ]);
  });

  it("names a record detecting a model the page has no row for, as npm run replacements --check does", () => {
    // Notes that name no replacement, as for a model OpenAI gives none, so only the missing row speaks.
    expect(pageDisagreements([record("zzq-gone", { replacedBy: "\u2014" })], page, lists)).toEqual([
      "openai:2026-11-01:zzq-gone-shut-down: the page has no row for zzq-gone",
    ]);
  });

  it("reads replacements against the spec's models, as npm run replacements does", () => {
    const renamed = record("zzq-one", { replacement: { model: "zzq-new", source: PAGE } });
    expect(pageDisagreements([renamed], page, lists)).toEqual([
      "openai:2026-11-01:zzq-one-shut-down: its replacements are not what the page gives",
    ]);
    expect(pageDisagreements([renamed], page, { ...lists, known: new Set(["zzq-new"]) })).toEqual([]);
  });

  it("names a record of a whole-row date missing a model its rows list, as npm run replacements --check does", () => {
    const rows = table([["2027-03-01", "zzq-one | zzq-one-2026-01-01", "zzq-new"]]);
    expect(pageDisagreements([record("zzq-one")], rows, lists)).toEqual([]);
    expect(pageDisagreements([record("zzq-one")], rows, { ...lists, wholeDates: new Set(["2027-03-01"]) })).toEqual([
      "openai:2026-11-01:zzq-one-shut-down: its replacements are not what the page gives",
    ]);
    expect(pageDisagreements([record("zzq-one")], rows, { ...lists, wholeDates: new Set(["2027-09-09"]) })).toEqual([
      "no model row on the page shuts down on 2027-09-09; take it off the list",
    ]);
  });
});
