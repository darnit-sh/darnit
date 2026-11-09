import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { account, readRemovals } from "../src/corpus/accounting.js";
import type { VendorConfig } from "../src/corpus/candidates.js";
import { listLines, pageDisagreements, pageItems, readPageRows } from "../src/corpus/page-rows.js";
import { modelIds, parseSpec } from "../src/corpus/spec.js";
import { forTerminal } from "../src/fix.js";
import { loadRecords } from "../src/records/load.js";
import { recordModels, type ChangeRecord } from "../src/records/schema.js";
import type { Page } from "../src/corpus/replacements.js";
import {
  judgeCeiling,
  notesSection,
  openEntries,
  parseFlags,
  pageTooOld,
  readNotCovered,
  refuseExisting,
  writeNotes,
} from "./accounting-final.js";
import { show } from "./show.js";

// Every deprecation in each vendor's spec and every removal in its corpus history is either covered
// by a record or listed in packs/<vendor>/not-covered.yaml with the reason it has none. Exit 1 on
// anything unaccounted for, and on entries that name an item no longer there or one a record covers.
// Items marked needs-record stay open and are listed on every run, soonest date first. For a vendor whose
// deprecations page vendors.yml names, each row of corpus/<vendor>/page-rows.json is an item too, one per model for a
// model row, and anything npm run replacements --check finds between the records and those rows fails the run.
// Nothing is fetched: the weekly corpus run saves the rows.
// --root <dir> reads vendors.yml, corpus/ and packs/ from another folder.
// --final, for a final release, also exits 1 when a vendor has more open items than packs/<vendor>/record-ceiling.txt
// allows, the accounting fails, or a vendor's page-rows.json was fetched over 14 days before today or is dated after
// it, and --notes <file> with it writes the open items as Markdown for the release notes
// to a new file, on a pass only. Any other flag, or a misspelled one, exits 2.

let flags: ReturnType<typeof parseFlags>;
try {
  flags = parseFlags(process.argv.slice(2));
} catch (err) {
  console.log(forTerminal(`accounting: ${show(err instanceof Error ? err.message : String(err))}`));
  process.exit(2);
}
const ROOT = flags.root !== undefined ? resolve(flags.root) : fileURLToPath(new URL("../", import.meta.url));
const out: string[] = [];
// Today in UTC, as the corpus run dates the files it saves, so a run's verdict does not depend on its time zone.
const today = new Date().toISOString().slice(0, 10);

/**
 * The first row in page order is taken as a model's newest only while its date is the latest of the model's rows with a
 * date darnit reads; a row with no such date, as "at earliest 2024-06-13", is left out.
 */
function pageOrderProblems(page: Page): string[] {
  const dated = new Map<string, string[]>();
  for (const row of page.rows)
    for (const m of row.models ?? []) if (row.shutdown) dated.set(m, [...(dated.get(m) ?? []), row.shutdown]);
  return [...dated].flatMap(([m, [first, ...rest]]) => {
    const later = rest.find((d) => d > first!);
    return later
      ? [`page order changed for ${m}: the first row is ${first}, a later row is ${later}; check which row is current`]
      : [];
  });
}

/**
 * Each record whose shutdown date is not that of the newest row naming a model it detects: the first row in page
 * order, the row npm run replacements takes a model's replacement from. Only that row counts, because an older table
 * can name a model again with an older date: gpt-4-0314 in an earlier price table ("at earliest 2024-06-13") and
 * code-davinci-002 in the Codex shutdown table (2023-03-23) both have newer rows with the dates their records give.
 * Every record detecting the model must match it. That the first row is the newest is checked, not trusted: see
 * pageOrderProblems.
 */
function shutdownMismatches(page: Page, records: readonly ChangeRecord[], vendor: string): string[] {
  const newest = new Map<string, string>();
  for (const row of page.rows)
    for (const m of row.models ?? []) if (!newest.has(m)) newest.set(m, row.shutdown ?? "no date read");
  return records.flatMap((r) =>
    r.vendor !== vendor
      ? []
      : recordModels(r)
          .filter((m) => newest.has(m) && newest.get(m) !== r.effectiveAt)
          .map(
            (m) =>
              `${r.id}: ${m} shuts down on ${newest.get(m)} on the page, ${r.effectiveAt ?? "no date"} in the record`,
          ),
  );
}

const notes: string[] = [];
// Printed only once the notes, when asked for, are written, so no verdict line stands above a failure to write them.
const verdicts: string[] = [];
// Every message goes out once, fenced and with control characters gone; a failure, whose message can quote
// spec text (a YAML error quotes the line it stopped at), is shown quoted and escaped like an item.
try {
  if (flags.notes !== undefined) await refuseExisting(flags.notes);
  const vendors = parseYaml(await readFile(join(ROOT, "vendors.yml"), "utf8")) as Record<
    string,
    VendorConfig & { page?: string }
  >;
  const records = (await loadRecords(join(ROOT, "packs"))).map((l) => l.record);

  for (const [vendor, config] of Object.entries(vendors)) {
    const notCoveredFile = `packs/${vendor}/not-covered.yaml`;
    const rowsFile = `corpus/${vendor}/page-rows.json`;
    const corpus = (file: string) => readFile(join(ROOT, "corpus", vendor, file), "utf8");
    const spec = parseSpec(await corpus("openapi.yaml"));
    const rows = config.page === undefined ? undefined : readPageRows(await corpus("page-rows.json"), config.page);
    const page = rows && pageItems(rows.page, records, vendor);
    const result = account({
      vendor,
      spec,
      removals: await readRemovals(join(ROOT, "corpus", vendor, "removals.json")),
      records,
      notCovered: await readNotCovered(ROOT, vendor),
      symbols: config.symbols,
      pageItems: page,
    });
    // Read as the rows file is: a missing list stops the run, as npm run replacements does.
    const list = async (file: string) => new Set(listLines(await corpus(file)));
    const disagreements = rows
      ? pageDisagreements(records, rows.page, {
          known: modelIds(spec),
          notModels: await list("non-model-rows.txt"),
          wholeDates: await list("whole-rows.txt"),
        })
      : [];
    const dates = rows ? shutdownMismatches(rows.page, records, vendor) : [];
    const order = rows ? pageOrderProblems(rows.page) : [];
    const onPage = rows
      ? `, ${page!.length} item${page!.length === 1 ? "" : "s"} on the deprecations page fetched ${rows.fetchedAt}`
      : "";
    out.push(
      `${vendor}: ${result.deprecated} deprecated in the spec, ${result.removals} removals in the corpus history${onPage}`,
    );
    out.push(
      `  ${result.covered.size} covered by records, ${result.reasons.length} with a reason, ${result.needsRecord.length} need a record, ${result.unaccounted.length} unaccounted for`,
    );
    const section = (title: string, lines: string[]) => {
      if (lines.length > 0) out.push("", title, ...lines.map((line) => `  ${line}`));
    };
    const open = openEntries(result.needsRecord, today);
    section(
      "Open, needs a record (soonest first):",
      open.flatMap((o) => [`- ${o.head}`, ...o.keys.map((k) => `    ${show(k)}`)]),
    );
    section(`Not accounted for (add a record, or an entry in ${notCoveredFile}):`, result.unaccounted.map(show));
    section(
      `Entries in ${notCoveredFile} for items no longer in the spec${rows ? ", the corpus history or the deprecations page rows" : " or the corpus history"} (remove them):`,
      result.stale.map(show),
    );
    section(
      `Entries in ${notCoveredFile} for items a record covers (remove them):`,
      result.redundant.map((r) => `${show(r.key)}: ${r.ids.join(", ")}`),
    );
    section(
      `Reasons in ${notCoveredFile} that the spec or the corpus history contradicts (correct them):`,
      result.contradicted.map(show),
    );
    section(
      `Where the records and ${rowsFile} disagree, as npm run replacements -- --rows ${rowsFile} --check finds it (correct the records):`,
      disagreements.map(show),
    );
    section(
      `Records whose shutdown date is not the one the newest row of ${rowsFile} gives for a model they detect (correct the record):`,
      dates.map(show),
    );
    section(`Models whose rows in ${rowsFile} are not newest first:`, order.map(show));
    const failed =
      result.unaccounted.length +
        result.stale.length +
        result.redundant.length +
        result.contradicted.length +
        disagreements.length +
        dates.length +
        order.length >
      0;
    if (failed) process.exitCode = 1;
    if (flags.final) {
      const items = result.deprecated + result.removals + (page?.length ?? 0);
      const tooOld = rows && pageTooOld(rowsFile, rows.fetchedAt, today);
      const verdict = await judgeCeiling({
        root: ROOT,
        vendor,
        open: result.needsRecord.length,
        items,
        failed,
        tooOld,
      });
      verdicts.push(verdict.line);
      if (!verdict.ok) process.exitCode = 1;
      notes.push(...notesSection(vendor, open));
    }
  }
  const refused = process.exitCode === 1;
  if (flags.notes !== undefined && !refused) await writeNotes(flags.notes, notes);
  if (verdicts.length > 0) out.push("", ...verdicts);
  if (flags.notes !== undefined && refused) out.push("", "No notes written: the final release is refused.");
} catch (err) {
  out.push(`accounting stopped: ${show(err instanceof Error ? err.message : String(err))}`);
  process.exitCode = 1;
}
console.log(forTerminal(out.join("\n")));
