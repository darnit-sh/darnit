import { loadRecords } from "../src/records/load.js";
import { runPackFixtures } from "../src/packs/fixtures.js";

// Runs every pack's fixtures. Exit 1 on any problem, so CI fails on drift,
// on silent no-match rules, and on packs that have no fixtures at all.

const records = await loadRecords();
let failed = 0;
let passed = 0;

for (const { record, packDir } of records) {
  for (const result of await runPackFixtures(packDir, record)) {
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
