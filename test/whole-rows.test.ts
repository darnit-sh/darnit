import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { readPage, wholeRows, type Page } from "../src/corpus/replacements.js";
import { loadRecords } from "../src/records/load.js";
import { recordModels, type ChangeRecord } from "../src/records/schema.js";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

/** Whether the record already detects its date's rows whole, one of them an alias with its dated snapshots. */
function detectsAliasRowsWhole(r: ChangeRecord, records: readonly ChangeRecord[], page: Page): boolean {
  const date = r.effectiveAt;
  if (date === undefined) return false;
  const ids = wholeRows(records, page, new Set([date])).models.get(r.id);
  const aliasRow = page.rows.some(
    ({ models = [], shutdown }) =>
      shutdown === date &&
      models.length > 1 &&
      recordModels(r).includes(models[0]!) &&
      models.slice(1).every((m) => m.startsWith(`${models[0]}-`)),
  );
  return aliasRow && JSON.stringify(ids) === JSON.stringify(recordModels(r));
}

it("lists in corpus/openai/whole-rows.txt exactly the dates of the records that detect their alias rows whole", async () => {
  const page = readPage(await read("./fixtures/deprecations.html"));
  const records = (await loadRecords()).map((l) => l.record).filter((r) => r.vendor === "openai");
  // Read as scripts/replacements.ts reads it.
  const dates = (await read("../corpus/openai/whole-rows.txt"))
    .split("\n")
    .filter((l) => l !== "" && !l.startsWith("#"));
  const held = wholeRows(records, page, new Set(dates)).models;
  expect(dates.filter((d) => !records.some((r) => r.effectiveAt === d && held.has(r.id)))).toEqual([]);
  const whole = records.filter((r) => detectsAliasRowsWhole(r, records, page));
  expect(whole.map((r) => r.effectiveAt).filter((d) => !dates.includes(d!))).toEqual([]);
  expect(whole.length).toBeGreaterThan(0);
});
