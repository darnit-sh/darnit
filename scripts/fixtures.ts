import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadRecords, PACKS_DIR } from "../src/records/load.js";
import { runPackFixtures } from "../src/packs/fixtures.js";

// Runs every pack's fixtures. Exit 1 on any problem, so CI fails on drift,
// on silent no-match rules, and on packs that have no fixtures at all.
// Given case folders (packs/<vendor>/<pack>/fixtures/<case>), runs only those cases.

const only = process.argv.slice(2).map((dir) => resolve(dir));

// A record that does not load is a failure to report, not a crash: its message names it, and a stack trace adds nothing.
const records = await loadRecords().catch((err: unknown) => {
  console.log(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
let failed = 0;
let passed = 0;

// A pack folder without change.json is never loaded, so its rules and fixtures would never run.
for (const vendor of readdirSync(PACKS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()))
  for (const pack of readdirSync(join(PACKS_DIR, vendor.name), { withFileTypes: true }).filter((d) => d.isDirectory()))
    if (!existsSync(join(PACKS_DIR, vendor.name, pack.name, "change.json"))) {
      failed += 1;
      console.log(`✗ ${vendor.name}/${pack.name} has no change.json`);
    }

for (const { record, packDir } of records) {
  for (const result of await runPackFixtures(packDir, record)) {
    if (only.length > 0 && !only.includes(join(packDir, "fixtures", result.case))) continue;
    const label = `${record.vendor}/${result.pack} · ${result.case}`;
    if (result.problems.length === 0) {
      passed += 1;
      console.log(`✓ ${label}`);
    } else {
      failed += 1;
      console.log(`✗ ${label}`);
      for (const p of result.problems) console.log(`    ${p.replace(/\n/g, "\n    ")}`);
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${records.length} packs`);
if (failed > 0 || records.length === 0) process.exit(1);
