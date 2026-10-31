import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { account, NotCoveredSchema, readOptional, RemovalSchema } from "../src/corpus/accounting.js";
import type { VendorConfig } from "../src/corpus/candidates.js";
import { parseSpec } from "../src/corpus/spec.js";
import { forTerminal } from "../src/fix.js";
import { loadRecords, PACKS_DIR } from "../src/records/load.js";

// Every deprecation in each vendor's spec and every removal in its corpus history is either covered
// by a record or listed in packs/<vendor>/not-covered.yaml with the reason it has none. Exit 1 on
// anything unaccounted for, and on entries that name an item no longer there or one a record covers.
// Items marked needs-record stay open and are listed on every run. --corpus <dir> reads another corpus folder.

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const at = process.argv.indexOf("--corpus");
const corpus = at > 0 ? resolve(process.argv[at + 1] ?? "") : join(ROOT, "corpus");

const vendors = parseYaml(await readFile(join(ROOT, "vendors.yml"), "utf8")) as Record<string, VendorConfig>;
const records = (await loadRecords()).map((l) => l.record);
// Keys are spec text: quoted, and anything outside printable ASCII written as an escape, so a name cannot hide or forge a line.
const show = (key: string) => JSON.stringify(key).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const out: string[] = [];

for (const [vendor, config] of Object.entries(vendors)) {
  const notCoveredFile = `packs/${vendor}/not-covered.yaml`;
  const result = account({
    vendor,
    spec: parseSpec(await readFile(join(corpus, vendor, "openapi.yaml"), "utf8")),
    removals: RemovalSchema.array().parse(JSON.parse((await readOptional(join(corpus, vendor, "removals.json"))) || "[]")),
    records,
    notCovered: NotCoveredSchema.parse(parseYaml(await readOptional(join(PACKS_DIR, vendor, "not-covered.yaml"))) ?? []),
    symbols: config.symbols,
  });
  out.push(`${vendor}: ${result.deprecated} deprecated in the spec, ${result.removals} removals in the corpus history`);
  out.push(`  ${result.covered.size} covered by records, ${result.reasons.length} with a reason, ${result.needsRecord.length} need a record, ${result.unaccounted.length} unaccounted for`);
  const section = (title: string, lines: string[]) => {
    if (lines.length > 0) out.push("", title, ...lines.map((line) => `  ${line}`));
  };
  const open = new Map<string, string[]>();
  for (const n of result.needsRecord) open.set(n.proposal, [...(open.get(n.proposal) ?? []), n.key]);
  section("Open, needs a record:", [...open].flatMap(([proposal, keys]) => [`- ${proposal.replace(/\s+/g, " ").trim()}`, ...keys.map((k) => `    ${show(k)}`)]));
  section(`Not accounted for (add a record, or an entry in ${notCoveredFile}):`, result.unaccounted.map(show));
  section(`Entries in ${notCoveredFile} for items no longer in the spec or the corpus history (remove them):`, result.stale.map(show));
  section(`Entries in ${notCoveredFile} for items a record covers (remove them):`, result.redundant.map((r) => `${show(r.key)}: ${r.ids.join(", ")}`));
  if (result.unaccounted.length + result.stale.length + result.redundant.length > 0) process.exitCode = 1;
}
console.log(forTerminal(out.join("\n")));
