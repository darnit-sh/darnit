import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pageMismatches, readPage, replacementsFor } from "../src/corpus/replacements.js";
import { modelIds, parseSpec } from "../src/corpus/spec.js";
import { shown } from "../src/detect.js";
import { loadRecords, PACKS_DIR } from "../src/records/load.js";
import { parseChangeRecord, recordModels } from "../src/records/schema.js";

// Writes fix.models into every record that detects models, from a saved copy of OpenAI's deprecations page, renaming
// only to models OpenAI's API spec in corpus/openai lists. Fails where a record's notes disagree with the page, or the
// page has no row it could read for a detected model.
// Usage: npm run replacements -- --page <saved page> [--check]
// --check writes nothing and also fails when a record's fix.models is not what the page gives.

const { values } = parseArgs({ options: { check: { type: "boolean" }, page: { type: "string" } } });
if (values.page === undefined) {
  console.error("usage: npm run replacements -- --page <saved copy of https://developers.openai.com/api/docs/deprecations> [--check]");
  process.exit(2);
}
const page = readPage(await readFile(values.page, "utf8"));
const loaded = await loadRecords();
const records = loaded.map((l) => l.record);
const known = modelIds(parseSpec(await readFile(join(PACKS_DIR, "../corpus/openai/openapi.yaml"), "utf8")));
const { models: wanted, problems } = replacementsFor(records, page, known);
problems.push(...pageMismatches(records, page));

for (const { record, packDir, file } of loaded) {
  const models = wanted.get(record.id);
  if (!models || JSON.stringify(record.fix?.models) === JSON.stringify(models)) continue;
  if (values.check) {
    problems.push(`${file}: fix.models is not what the page gives; run npm run replacements -- --page <page>`);
    continue;
  }
  const path = join(packDir, "change.json");
  const raw = JSON.parse(await readFile(path, "utf8")) as { fix?: object };
  raw.fix = { ...raw.fix, models };
  parseChangeRecord(raw, file);
  await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
  console.log(`wrote ${file}`);
}

const list = (title: string, lines: string[]) => lines.length > 0 && console.log([`${title}:`, ...lines.map((l) => `  ${shown(l)}`)].join("\n"));
const entries = [...wanted.values()].flatMap((m) => Object.entries(m));
const people = entries.flatMap(([m, r]) => ("human" in r ? [`${m}: ${r.human}`] : []));
console.log(`${entries.length} detected models: ${entries.length - people.length} plain renames, ${people.length} for a person`);
list("For a person", people);
list(
  "Named in several rows with different replacements, newest row used",
  [...page.replacements].flatMap(([m, texts]) => (new Set(texts).size > 1 ? [`${m}: ${texts.join(" | ")}`] : [])),
);
const detected = new Set(records.flatMap(recordModels));
list("On the page, detected by no record", [...page.replacements.keys()].filter((m) => !detected.has(m)));
list("Not read as model rows", page.skipped);
list("✗ Problems", problems);
process.exitCode = problems.length > 0 ? 1 : 0;
