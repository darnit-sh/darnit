import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { appendRemovals, removalsFrom, type Removal } from "../src/corpus/accounting.js";
import { deriveCandidates, writeCandidate, type VendorConfig } from "../src/corpus/candidates.js";
import { changelog } from "../src/corpus/oasdiff.js";
import { prose } from "../src/fix.js";
import { parseSpec, sha256 } from "../src/corpus/spec.js";
import { loadRecords, PACKS_DIR } from "../src/records/load.js";

// Fetches each vendor's spec, diffs it against the last snapshot, and writes
// candidate packs for anything users would have to change, and appends every removal to
// corpus/<vendor>/removals.json so npm run accounting can hold each one to account. --dry-run reports
// without writing. First run for a vendor only stores the baseline. The output is the
// pull request body, so text that came from the spec goes through prose(). --root <dir> reads
// vendors.yml and writes corpus/ and packs/ under another folder.

const at = process.argv.indexOf("--root");
const ROOT = at > 0 ? resolve(process.argv[at + 1] ?? "") : fileURLToPath(new URL("../", import.meta.url));
const packsDir = at > 0 ? join(ROOT, "packs") : PACKS_DIR;
const dryRun = process.argv.includes("--dry-run");
const today = new Date().toISOString().slice(0, 10);

const vendors = parseYaml(await readFile(join(ROOT, "vendors.yml"), "utf8")) as Record<string, VendorConfig>;
const existing = (await loadRecords()).map((l) => l.record);

for (const [vendor, config] of Object.entries(vendors)) {
  const dir = join(ROOT, "corpus", vendor);
  const specPath = join(dir, "openapi.yaml");
  const snapshotPath = join(dir, "snapshot.json");
  const removalsPath = join(dir, "removals.json");
  const removed: Removal[] = [];

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
      removed.push(...removalsFrom(entries, today));
      const { candidates, ignored, unmapped } = deriveCandidates({ vendor, config, entries, spec: parseSpec(text), existing, observedAt: today });
      console.log(`## ${vendor}: ${entries.length} spec changes, ${candidates.length} candidate records`);
      for (const c of candidates) {
        console.log(`- ${c.record.id}: ${prose(c.record.title ?? "")}`);
        if (!dryRun) await writeCandidate(packsDir, c);
      }
      if (unmapped.length > 0) console.log(`\nEndpoints with no SDK symbol in vendors.yml (add one so SDK calls are found too): ${prose(unmapped.join(", "))}`);
      const ignoredLines = Object.entries(ignored).sort((a, b) => b[1] - a[1]);
      if (ignoredLines.length > 0) console.log(`\nNot turned into records:\n${ignoredLines.map(([why, n]) => `- ${n} × ${prose(why)}`).join("\n")}`);
    } finally {
      await rm(fresh, { force: true });
    }
  }

  if (!dryRun) {
    await mkdir(dir, { recursive: true });
    // Before the new spec replaces the old one, so a failed append leaves the diff to be taken again.
    if (removed.length > 0) await appendRemovals(removalsPath, removed);
    await writeFile(specPath, text);
    await writeFile(snapshotPath, `${JSON.stringify({ source: config.spec, sha256: sha, fetchedAt: today }, null, 2)}\n`);
  }
}
