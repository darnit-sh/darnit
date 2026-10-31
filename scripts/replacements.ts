import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pageMismatches, pageRows, replacementsFor } from "../src/corpus/replacements.js";
import { loadRecords } from "../src/records/load.js";
import { parseChangeRecord } from "../src/records/schema.js";

// Writes fix.models into every record that detects models, from the replacements its notes.migration names.
// Usage: npm run replacements [-- --check] [--page <saved copy of the deprecations page>]
// --check writes nothing and fails when a record's fix.models is not what its notes give.
// --page also fails when the notes and the page's tables disagree on a model's replacement.

const { values } = parseArgs({ options: { check: { type: "boolean" }, page: { type: "string" } } });
const loaded = await loadRecords();
const records = loaded.map((l) => l.record);
const problems: string[] = [];
if (values.page !== undefined) problems.push(...pageMismatches(records, pageRows(await readFile(values.page, "utf8"))));

const wanted = replacementsFor(records);
for (const { record, packDir, file } of loaded) {
  const models = wanted.get(record.id);
  if (!models) continue;
  if (JSON.stringify(record.fix?.models) === JSON.stringify(models)) continue;
  if (values.check) {
    problems.push(`${file}: fix.models is not what its notes give; run npm run replacements`);
    continue;
  }
  const path = join(packDir, "change.json");
  const raw = JSON.parse(await readFile(path, "utf8")) as { fix?: object };
  raw.fix = { ...raw.fix, models };
  parseChangeRecord(raw, file);
  await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
  console.log(`wrote ${file}`);
}
for (const p of problems) console.log(`✗ ${p}`);
process.exitCode = problems.length > 0 ? 1 : 0;
