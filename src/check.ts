import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { listFiles, vendorClients } from "./detect.js";
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

/** What a check covered, so a clean result can say what it was clean against. */
export type Coverage = { files: number; records: number; foreign?: number };

/** Hits for `records` in `files` (relative to `root`). Files darnit cannot parse are skipped. */
export async function scan(
  root: string,
  files: readonly string[],
  records: readonly ChangeRecord[],
): Promise<{ hits: Hit[]; scanned: number; foreign: Hit[] }> {
  const hits: Hit[] = [];
  // Calls through another provider's client (Groq's SDK, the vendor's SDK pointed elsewhere): never reported.
  const foreign: Hit[] = [];
  let scanned = 0;
  // Known limit: each file is parsed once per record. Fine for a handful of records; index them by vendor as the corpus grows.
  for (const file of files) {
    const grammar = grammarFor(file);
    if (!grammar) continue;
    const text = await readFile(join(root, file), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    scanned++;
    for (const record of records) {
      const patterns = record.detection.astGrepPatterns[grammar.lang];
      if (!patterns) continue;
      const { sdkSymbols: symbols, endpoints } = record.surface;
      const vendor = vendorClients(record.vendor);
      for (const match of findMatches(text, grammar.grammar, patterns, { symbols, endpoints, vendor })) {
        (match.foreign ? foreign : hits).push({ ...match, record, file });
      }
    }
  }
  return { hits, scanned, foreign };
}

/** Every call site in `root` affected by a known vendor change, and what was covered. */
export async function checkReport(root: string): Promise<{ hits: Hit[]; coverage: Coverage }> {
  const only = await configuredVendors(root);
  const records = (await loadRecords()).map((l) => l.record).filter((r) => !only || only.has(r.vendor));
  const { hits, scanned, foreign } = await scan(root, await listFiles(root), records);
  return { hits, coverage: { files: scanned, records: records.length, ...(foreign.length > 0 ? { foreign: foreign.length } : {}) } };
}

/** Every call site in `root` affected by a known vendor change. */
export async function check(root: string): Promise<Hit[]> {
  return (await checkReport(root)).hits;
}

/** The record's own title, or one derived from its data for records without one. */
export function title(r: ChangeRecord): string {
  if (r.title) return r.title;
  const fields = (r.surface.fields ?? []).join(", ");
  const on = r.surface.sdkSymbols ? ` on ${r.surface.sdkSymbols.join(", ")}` : "";
  return `${r.kind}: ${fields}${on}`;
}

const heading = (r: ChangeRecord) =>
  `${r.vendor} ${r.announcedAt}: ${title(r)}${r.status === "candidate" ? " (unreviewed change, detection only)" : ""}`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Machine-readable form of the hits. */
export function toJson(hits: Hit[]): object[] {
  return hits.map((h) => ({
    id: h.record.id,
    title: title(h.record),
    status: h.record.status,
    vendor: h.record.vendor,
    announcedAt: h.record.announcedAt,
    kind: h.record.kind,
    file: h.file,
    line: h.line,
    column: h.column,
    text: h.text,
    sources: h.record.sources.map((s) => s.url),
  }));
}

const NOT_CHECKED = "Not checked: request options built elsewhere and passed in as a variable.";

/** 1 only for call sites of a reviewed change: a machine-written candidate nobody has read should not fail anyone's build. */
export const exitCodeForCheck = (hits: readonly Hit[]): 0 | 1 => (hits.some((h) => h.record.status === "reviewed") ? 1 : 0);

/** Terminal report, grouped by vendor change. Always ends by saying what was and was not covered. */
export function render(hits: Hit[], coverage?: Coverage): string {
  const footer = [
    ...(coverage
      ? [`Scanned ${plural(coverage.files, "JavaScript, TypeScript or Python file")} against ${plural(coverage.records, "change record")}.`]
      : []),
    ...(coverage?.foreign
      ? [`Left out ${plural(coverage.foreign, "call")} made through another provider's client with the same methods.`]
      : []),
    NOT_CHECKED,
  ];
  if (hits.length === 0) return ["No known vendor changes affect this repository.", "", ...footer].join("\n");
  const groups = new Map<string, Hit[]>();
  for (const hit of hits) groups.set(hit.record.id, [...(groups.get(hit.record.id) ?? []), hit]);

  const out: string[] = [];
  for (const group of groups.values()) {
    const record = group[0]!.record;
    const locations = group.map((h) => `${h.file}:${h.line}:${h.column}`);
    const width = Math.max(...locations.map((l) => l.length)) + 2;
    out.push(heading(record));
    group.forEach((h, i) => out.push(`  ${locations[i]!.padEnd(width)}${h.text.split("\n")[0]!.slice(0, 60)}`));
    out.push(`  ${plural(group.length, "call site")} in ${plural(new Set(group.map((h) => h.file)).size, "file")}`);
    for (const source of record.sources) out.push(`  ${source.url}`);
    out.push("");
  }
  if (exitCodeForCheck(hits) === 0) out.push("Unreviewed changes are reported but do not fail the check.");
  out.push(...footer);
  return out.join("\n");
}
