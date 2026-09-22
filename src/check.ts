import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { listFiles, VENDORS, type Vendor } from "./detect.js";
import { loadRecords } from "./records/load.js";
import type { ChangeRecord } from "./records/schema.js";
import { findMatches, grammarFor, type Match } from "./scan/astgrep.js";

export type Hit = Match & { record: ChangeRecord; file: string };

/** Vendors listed in darnit.yml, when the file exists and lists any; otherwise no restriction. */
async function configuredVendors(root: string): Promise<Set<string> | undefined> {
  const text = await readFile(join(root, "darnit.yml"), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const apis = (parseYaml(text) as { apis?: Record<string, unknown> } | null)?.apis;
    const names = Object.keys(apis ?? {});
    return names.length > 0 ? new Set(names) : undefined;
  } catch {
    return undefined;
  }
}

/** Cheap pre-filter for records with no call symbols or endpoints: a file that never names the vendor cannot be calling it. */
function mentionsVendor(text: string, vendor: string): boolean {
  const known = (VENDORS as Partial<Record<string, (typeof VENDORS)[Vendor]>>)[vendor];
  const needles = known ? [...known.npm, ...known.pypi, ...known.hosts] : [vendor];
  return needles.some((n) => text.includes(n));
}

/** Every call site in `root` affected by a known vendor change. */
export async function check(root: string): Promise<Hit[]> {
  const only = await configuredVendors(root);
  const records = (await loadRecords()).filter(({ record }) => !only || only.has(record.vendor));
  const hits: Hit[] = [];
  // ponytail: parses every source file once per record; index records by vendor if the corpus grows large
  for (const file of await listFiles(root)) {
    const grammar = grammarFor(file);
    if (!grammar) continue;
    const text = await readFile(join(root, file), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    for (const { record } of records) {
      const patterns = record.detection.astGrepPatterns[grammar.lang];
      if (!patterns) continue;
      const { sdkSymbols: symbols, endpoints } = record.surface;
      if (!symbols?.length && !endpoints?.length && !mentionsVendor(text, record.vendor)) continue;
      for (const match of findMatches(text, grammar.grammar, patterns, { symbols, endpoints })) hits.push({ ...match, record, file });
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
