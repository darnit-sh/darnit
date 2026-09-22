import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listFiles, VENDORS, type Vendor } from "./detect.js";
import { loadRecords } from "./records/load.js";
import type { ChangeRecord } from "./records/schema.js";
import { findMatches, grammarFor, type Match } from "./scan/astgrep.js";

export type Hit = Match & { record: ChangeRecord; file: string };

/** Cheap pre-filter: a file that never names the vendor cannot be calling it. */
function mentionsVendor(text: string, vendor: string): boolean {
  const known = (VENDORS as Partial<Record<string, (typeof VENDORS)[Vendor]>>)[vendor];
  const needles = known ? [...known.npm, ...known.pypi, ...known.hosts] : [vendor];
  return needles.some((n) => text.includes(n));
}

/** Every call site in `root` affected by a known vendor change. */
export async function check(root: string): Promise<Hit[]> {
  const records = await loadRecords();
  const hits: Hit[] = [];
  for (const file of await listFiles(root)) {
    const grammar = grammarFor(file);
    if (!grammar) continue;
    const text = await readFile(join(root, file), "utf8");
    for (const { record } of records) {
      const patterns = record.detection.astGrepPatterns[grammar.lang];
      if (!patterns || !mentionsVendor(text, record.vendor)) continue;
      const gate = { symbols: record.surface.sdkSymbols, endpoints: record.surface.endpoints };
      for (const match of findMatches(text, grammar.grammar, patterns, gate)) hits.push({ ...match, record, file });
    }
  }
  return hits;
}

function title(r: ChangeRecord): string {
  const fields = (r.surface.fields ?? []).join(", ");
  const on = r.surface.sdkSymbols ? ` on ${r.surface.sdkSymbols.join(", ")}` : "";
  return `${r.vendor} ${r.announcedAt}, ${r.kind}: ${fields}${on}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Terminal report, grouped by vendor change. */
export function render(hits: Hit[]): string {
  if (hits.length === 0) return "No known vendor changes affect this repository.";
  const groups = new Map<string, Hit[]>();
  for (const hit of hits) groups.set(hit.record.id, [...(groups.get(hit.record.id) ?? []), hit]);

  const out: string[] = [];
  for (const group of groups.values()) {
    const record = group[0]!.record;
    const locations = group.map((h) => `${h.file}:${h.line}:${h.column}`);
    const width = Math.max(...locations.map((l) => l.length)) + 2;
    out.push(title(record));
    group.forEach((h, i) => out.push(`  ${locations[i]!.padEnd(width)}${h.text.split("\n")[0]!.slice(0, 60)}`));
    out.push(`  ${plural(group.length, "call site")} in ${plural(new Set(group.map((h) => h.file)).size, "file")}`);
    for (const source of record.sources) out.push(`  ${source.url}`);
    out.push("");
  }
  out.push("Not checked: options objects built in one place and passed by name.");
  return out.join("\n");
}
