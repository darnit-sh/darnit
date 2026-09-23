import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { deriveCandidates, writeCandidate, type VendorConfig } from "../src/corpus/candidates.js";
import { changelog } from "../src/corpus/oasdiff.js";
import { parseSpec, sha256 } from "../src/corpus/spec.js";
import { loadRecords, PACKS_DIR } from "../src/records/load.js";

// Fetches each vendor's spec, diffs it against the last snapshot, and writes
// candidate packs for anything users would have to change. --dry-run reports
// without writing. First run for a vendor only stores the baseline.

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const dryRun = process.argv.includes("--dry-run");
const today = new Date().toISOString().slice(0, 10);

const vendors = parseYaml(await readFile(join(ROOT, "vendors.yml"), "utf8")) as Record<string, VendorConfig>;
const existing = (await loadRecords()).map((l) => l.record);

for (const [vendor, config] of Object.entries(vendors)) {
  const dir = join(ROOT, "corpus", vendor);
  const specPath = join(dir, "openapi.yaml");
  const snapshotPath = join(dir, "snapshot.json");

  const res = await fetch(config.spec);
  if (!res.ok) {
    console.error(`${vendor}: could not fetch ${config.spec} (${res.status})`);
    process.exitCode = 2;
    continue;
  }
  const text = await res.text();
  const sha = sha256(text);
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8").catch(() => "null")) as { sha256: string } | null;

  if (snapshot?.sha256 === sha) {
    console.log(`${vendor}: no change since the last snapshot`);
    continue;
  }
  if (!snapshot) {
    console.log(`${vendor}: first snapshot stored; changes are reported from the next run on`);
  } else {
    const fresh = join(tmpdir(), `darnit-${vendor}-${sha.slice(0, 8)}.yaml`);
    await writeFile(fresh, text);
    try {
      const entries = await changelog(specPath, fresh);
      const { candidates, ignored, unmapped } = deriveCandidates({ vendor, config, entries, spec: parseSpec(text), existing, observedAt: today });
      console.log(`## ${vendor}: ${entries.length} spec changes, ${candidates.length} candidate records`);
      for (const c of candidates) {
        console.log(`- ${c.record.id}: ${c.record.title}${c.record.fix ? " (rename rules generated)" : ""}`);
        if (!dryRun) await writeCandidate(PACKS_DIR, c);
      }
      if (unmapped.length > 0) console.log(`\nEndpoints with no SDK symbol in vendors.yml (add one to enable rules): ${unmapped.join(", ")}`);
      const ignoredLines = Object.entries(ignored).sort((a, b) => b[1] - a[1]);
      if (ignoredLines.length > 0) console.log(`\nNot turned into records:\n${ignoredLines.map(([why, n]) => `- ${n} × ${why}`).join("\n")}`);
    } finally {
      await rm(fresh, { force: true });
    }
  }

  if (!dryRun) {
    await mkdir(dir, { recursive: true });
    await writeFile(specPath, text);
    await writeFile(snapshotPath, `${JSON.stringify({ source: config.spec, sha256: sha, fetchedAt: today }, null, 2)}\n`);
  }
}
