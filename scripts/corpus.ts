import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { appendRemovals, removalsFrom, type Removal } from "../src/corpus/accounting.js";
import { deriveCandidates, writeCandidate, type VendorConfig } from "../src/corpus/candidates.js";
import { changelog } from "../src/corpus/oasdiff.js";
import { fetchPage, listLines, pageRowsJson, unreadable } from "../src/corpus/page-rows.js";
import { readmeCounts } from "../src/corpus/readme.js";
import { readPage } from "../src/corpus/replacements.js";
import { prose } from "../src/fix.js";
import { modelIds, parseSpec, sha256 } from "../src/corpus/spec.js";
import { shown } from "../src/detect.js";
import { loadRecords } from "../src/records/load.js";

// Fetches each vendor's spec, diffs it against the last snapshot, and writes
// candidate packs for anything users would have to change, and appends every removal to
// corpus/<vendor>/removals.json so npm run accounting can hold each one to account. --dry-run reports
// without writing. First run for a vendor only stores the baseline. The output is the
// pull request body, so text that came from the spec goes through prose(). README.md's counts of
// change records and retiring models are set from the packs. For a vendor whose deprecations page vendors.yml names,
// the rows darnit reads from the page go to corpus/<vendor>/page-rows.json, only when it can read every table and row
// by the rules npm run replacements checks a page with. --root <dir> reads vendors.yml and writes corpus/, packs/ and
// README.md under another folder.

const at = process.argv.indexOf("--root");
const ROOT = at > 0 ? resolve(process.argv[at + 1] ?? "") : fileURLToPath(new URL("../", import.meta.url));
const dryRun = process.argv.includes("--dry-run");
const today = new Date().toISOString().slice(0, 10);

const vendors = parseYaml(await readFile(join(ROOT, "vendors.yml"), "utf8")) as Record<
  string,
  VendorConfig & { page?: string }
>;
const existing = (await loadRecords()).map((l) => l.record);

for (const [vendor, config] of Object.entries(vendors)) {
  const dir = join(ROOT, "corpus", vendor);
  const specPath = join(dir, "openapi.yaml");
  const snapshotPath = join(dir, "snapshot.json");
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
      const { candidates, ignored, unmapped } = deriveCandidates({
        vendor,
        config,
        entries,
        spec: parseSpec(text),
        existing,
        observedAt: today,
      });
      console.log(`## ${vendor}: ${entries.length} spec changes, ${candidates.length} candidate records`);
      for (const c of candidates) {
        console.log(`- ${c.record.id}: ${prose(c.record.title ?? "")}`);
        if (!dryRun) await writeCandidate(join(ROOT, "packs"), c);
      }
      if (unmapped.length > 0)
        console.log(
          `\nEndpoints with no SDK symbol in vendors.yml (add one so SDK calls are found too): ${prose(unmapped.join(", "))}`,
        );
      const ignoredLines = Object.entries(ignored).sort((a, b) => b[1] - a[1]);
      if (ignoredLines.length > 0)
        console.log(
          `\nNot turned into records:\n${ignoredLines.map(([why, n]) => `- ${n} × ${prose(why)}`).join("\n")}`,
        );
    } finally {
      await rm(fresh, { force: true });
    }
  }

  if (!dryRun) {
    await mkdir(dir, { recursive: true });
    // Before the new spec replaces the old one, so a failed append leaves the diff to be taken again.
    if (removed.length > 0) await appendRemovals(join(dir, "removals.json"), removed);
    await writeFile(specPath, text);
    await writeFile(
      snapshotPath,
      `${JSON.stringify({ source: config.spec, sha256: sha, fetchedAt: today }, null, 2)}\n`,
    );
  }
}

for (const [vendor, { page: url }] of Object.entries(vendors)) {
  if (url === undefined) continue;
  const dir = join(ROOT, "corpus", vendor);
  const file = `corpus/${vendor}/page-rows.json`;
  // Page text is data: printed through shown(), and never run or written anywhere but the rows file.
  const fail = (code: number, [why, ...lines]: string[]) => {
    console.error([`${vendor}: ${file} not saved: ${shown(why!)}`, ...lines.map((l) => `  ${shown(l)}`)].join("\n"));
    process.exitCode ??= code;
  };
  const html = await fetchPage(url).catch((err: Error) => err);
  if (html instanceof Error) {
    fail(2, [html.message]);
    continue;
  }
  const page = readPage(html);
  const known = modelIds(parseSpec(await readFile(join(dir, "openapi.yaml"), "utf8")));
  const notModels = new Set(listLines(await readFile(join(dir, "non-model-rows.txt"), "utf8").catch(() => "")));
  const problems = unreadable(page, existing, known, notModels);
  if (problems.length > 0) {
    fail(1, ["the page has a table or row darnit cannot read:", ...problems]);
    continue;
  }
  if (!dryRun) await writeFile(join(dir, "page-rows.json"), pageRowsJson(page, { source: url, fetchedAt: today }));
  console.log(`${vendor}: ${dryRun ? "would save" : "saved"} ${file}, ${page.rows.length} rows`);
}

const readme = await readFile(join(ROOT, "README.md"), "utf8").catch(() => undefined);
if (!dryRun && readme !== undefined) {
  await writeFile(
    join(ROOT, "README.md"),
    readmeCounts(
      readme,
      (await loadRecords(join(ROOT, "packs"))).map((l) => l.record),
    ),
  );
}
