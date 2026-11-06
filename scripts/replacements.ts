import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  modelDetection,
  modelFixtures,
  modelNotes,
  modelTitle,
  pageMismatches,
  readPage,
  replacementsFor,
  wholeRows,
} from "../src/corpus/replacements.js";
import { modelIds, parseSpec } from "../src/corpus/spec.js";
import { shown, vendorName } from "../src/detect.js";
import { loadRecords, PACKS_DIR } from "../src/records/load.js";
import { parseChangeRecord, recordModels, type ChangeRecord } from "../src/records/schema.js";

// Writes fix.models into every record that detects models, from a saved copy of OpenAI's deprecations page, renaming
// only to models OpenAI's API spec in corpus/openai lists. For each shutdown date in corpus/openai/whole-rows.txt, the
// record of that date also detects every model its page rows name, with its title, notes and fixture written to match.
// Fails where a record's notes disagree with the page, or the page has no row it could read for a detected model, or
// a table darnit cannot read as a person would, or any row on the page that may name one darnit did not read from it,
// is not in corpus/openai/non-model-rows.txt. Model names outside the page's tables, in lists or paragraphs, are not
// checked, nor a table hidden by a CSS class.
// Usage: npm run replacements -- --page <saved page> [--write | --check]
// With neither flag it writes nothing and lists what --write would change. --write writes nothing when the run finds
// any problem. --check also fails when a record is not what the page gives, naming each model the page lists that the
// record does not detect.

const { values } = parseArgs({
  options: { check: { type: "boolean" }, write: { type: "boolean" }, page: { type: "string" } },
});
if (values.page === undefined || (values.check && values.write)) {
  console.error(
    "usage: npm run replacements -- --page <saved copy of https://developers.openai.com/api/docs/deprecations> [--write | --check]",
  );
  process.exit(2);
}
const page = readPage(await readFile(values.page, "utf8"));
const loaded = await loadRecords();
const corpus = join(PACKS_DIR, "../corpus/openai");
const lines = async (file: string) =>
  (await readFile(join(corpus, file), "utf8")).split("\n").filter((l) => l !== "" && !l.startsWith("#"));
const known = modelIds(parseSpec(await readFile(join(corpus, "openapi.yaml"), "utf8")));
const whole = wholeRows(
  loaded.map((l) => l.record),
  page,
  new Set(await lines("whole-rows.txt")),
);
const problems = [...whole.problems];
const disk = await Promise.all(loaded.map((l) => readFile(join(l.packDir, "change.json"), "utf8")));

// Each record as the page gives it, before fix.models: a whole-row record with all its rows' models.
const shaped = loaded.map(({ record, packDir, file }, i) => {
  const ids = whole.models.get(record.id);
  const raw = JSON.parse(disk[i]!) as ChangeRecord;
  if (!ids) return { raw, record, packDir, file, files: {} };
  const missing = ids.filter((m) => !recordModels(record).includes(m));
  if (
    JSON.stringify(record.detection) !== JSON.stringify(modelDetection(recordModels(record))) ||
    !record.effectiveAt
  ) {
    problems.push(
      `${file}: its detection is not one model record's, so darnit does not add ${missing.join(", ") || "models"} to it`,
    );
    return { raw, record, packDir, file, files: {} };
  }
  if (values.check)
    for (const m of missing)
      problems.push(
        `${file}: does not detect ${m}, which the page lists in its ${record.effectiveAt} rows; run npm run replacements -- --page <page> --write`,
      );
  const fix = { ...raw.fix };
  delete fix.models;
  Object.assign(raw, {
    title: modelTitle(ids, record.effectiveAt),
    notes: { ...raw.notes, migration: modelNotes(vendorName(record.vendor), ids, record.effectiveAt, page) },
    detection: modelDetection(ids),
    fix,
  });
  return { raw, record: parseChangeRecord(raw, file), packDir, file, files: modelFixtures(ids) };
});

const records = shaped.map((s) => s.record);
const notModels = await lines("non-model-rows.txt");
const { models: wanted, problems: found } = replacementsFor(records, page, known, new Set(notModels));
problems.push(...found, ...pageMismatches(records, page));

// What --write would change: worked out whole before anything is written, so a run with a problem writes nothing.
const writes: { path: string; shown: string; text: string }[] = [];
for (const [i, { raw, packDir, file, files }] of shaped.entries()) {
  const models = wanted.get(raw.id);
  if (models) raw.fix = { ...raw.fix, models };
  const all: Record<string, string> = { "change.json": `${JSON.stringify(raw, null, 2)}\n`, ...files };
  const stale = JSON.stringify(JSON.parse(disk[i]!)) === JSON.stringify(raw) ? [] : ["change.json"];
  for (const [rel, text] of Object.entries(files))
    if ((await readFile(join(packDir, rel), "utf8").catch(() => undefined)) !== text) stale.push(rel);
  if (stale.length === 0) continue;
  if (values.check)
    problems.push(
      `${file}: ${stale.join(", ")} not what the page gives; run npm run replacements -- --page <page> --write`,
    );
  else if (!values.write)
    console.log(`--write would change ${stale.map((rel) => join(dirname(file), rel)).join(", ")}`);
  else {
    parseChangeRecord(raw, file);
    writes.push(
      ...stale.map((rel) => ({ path: join(packDir, rel), shown: join(dirname(file), rel), text: all[rel]! })),
    );
  }
}
if (values.write && problems.length > 0)
  console.log(`wrote nothing: the run has ${problems.length} problem${problems.length === 1 ? "" : "s"}, listed below`);
else
  for (const w of writes) {
    await mkdir(dirname(w.path), { recursive: true });
    await writeFile(w.path, w.text);
    console.log(`wrote ${w.shown}`);
  }

const list = (title: string, items: string[]) =>
  items.length > 0 && console.log([`${title}:`, ...items.map((l) => `  ${shown(l)}`)].join("\n"));
const entries = [...wanted.values()].flatMap((m) => Object.entries(m));
const people = entries.flatMap(([m, r]) => ("human" in r ? [`${m}: ${r.human}`] : []));
console.log(
  `${entries.length} detected models: ${entries.length - people.length} plain renames, ${people.length} for a person`,
);
list("For a person", people);
list(
  "Named in several rows with different replacements, newest row used",
  [...page.replacements].flatMap(([m, texts]) => (new Set(texts).size > 1 ? [`${m}: ${texts.join(" | ")}`] : [])),
);
list(
  "On the page, detected by no record, for later batches (add the date to corpus/openai/whole-rows.txt)",
  [...whole.later].map(([date, ids]) => `${date}: ${ids.join(", ")}`),
);
list("✗ Problems", problems);
process.exitCode = problems.length > 0 ? 1 : 0;
