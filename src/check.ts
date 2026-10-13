import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { listFiles, MAX_FILE_BYTES, readText, vendorClients } from "./detect.js";
import { loadRecords } from "./records/load.js";
import type { ChangeRecord } from "./records/schema.js";
import { findMatches, grammarFor, modelNames, type Match, type Span } from "./scan/astgrep.js";
import { findModelValues, inside, isTestPath, joined } from "./scan/values.js";

export type Hit = Match & { record: ChangeRecord; file: string };

/** A model name from a record set as a model value, not confirmed as a call site: reported, never failing the check. */
export type ModelValueHit = Hit & { model: string };

/** Vendors listed in darnit.yml, when the file exists and lists any; otherwise no restriction. */
async function configuredVendors(root: string): Promise<Set<string> | undefined> {
  const text = await readText(join(root, "darnit.yml"));
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
export type Coverage = { files: number; records: number; foreign?: number; foreignAt?: string[]; tooLarge?: string[] };

/** Hits for `records` in `files` (relative to `root`), and with `modelValues` the model names set as values outside test code. Files darnit cannot parse are skipped. */
export async function scan(
  root: string,
  files: readonly string[],
  records: readonly ChangeRecord[],
  { modelValues = false } = {},
): Promise<{ hits: Hit[]; scanned: number; foreign: Hit[]; tooLarge: string[]; values: ModelValueHit[] }> {
  const hits: Hit[] = [];
  const values: ModelValueHit[] = [];
  const byName = new Map(modelValues ? records.flatMap((r) => Object.values(r.detection.astGrepPatterns).flatMap((p) => modelNames(p)).map((n) => [n, r] as const)) : []);
  const names = new Set(byName.keys());
  // Calls through another provider's client (Groq's SDK, the vendor's SDK pointed elsewhere): never reported.
  const foreign: Hit[] = [];
  const tooLarge: string[] = [];
  let scanned = 0;
  // Known limit: each file is parsed once per record. Fine for a handful of records; index them by vendor as the corpus grows.
  for (const file of files) {
    const grammar = grammarFor(file);
    if (!grammar) continue;
    const text = await readText(join(root, file), () => tooLarge.push(file));
    if (text === undefined) continue;
    scanned++;
    const reported = new Map<string, Span[]>();
    for (const record of records) {
      const patterns = record.detection.astGrepPatterns[grammar.lang];
      if (!patterns) continue;
      const { sdkSymbols: symbols, endpoints } = record.surface;
      const vendor = vendorClients(record.vendor);
      for (const match of findMatches(text, grammar.grammar, patterns, { symbols, endpoints, vendor })) {
        (match.foreign ? foreign : hits).push({ ...match, record, file });
        const spans = reported.get(record.id);
        if (spans) spans.push(match.span);
        else reported.set(record.id, [match.span]);
      }
    }
    if (names.size === 0 || isTestPath(file)) continue;
    // A value inside a reported call site is already listed there.
    const covered = new Map([...reported].map(([id, spans]) => [id, joined(spans)]));
    for (const v of findModelValues(file, text, grammar.grammar, names)) {
      const record = byName.get(v.model)!;
      if (!inside(covered.get(record.id) ?? [], v.span.start, v.span.end)) values.push({ ...v, record, file });
    }
  }
  return { hits, scanned, foreign, tooLarge, values };
}

/** Every call site in `root` affected by a known vendor change, and what was covered. */
export async function checkReport(root: string): Promise<{ hits: Hit[]; coverage: Coverage; foreign: Hit[]; values: ModelValueHit[] }> {
  const only = await configuredVendors(root);
  const records = (await loadRecords()).map((l) => l.record).filter((r) => !only || only.has(r.vendor));
  const { hits, scanned, foreign, tooLarge, values } = await scan(root, await listFiles(root), records, { modelValues: true });
  const leftOut = foreign.length > 0 ? { foreign: foreign.length, foreignAt: foreign.map((h) => `${h.file}:${h.line}`) } : {};
  return { hits, foreign, values, coverage: { files: scanned, records: records.length, ...leftOut, ...(tooLarge.length > 0 ? { tooLarge } : {}) } };
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

const LABELS: Record<ChangeRecord["status"], string> = {
  candidate: " (unreviewed change, detection only)",
  "parser-verified": " (parser-verified, not read by a person)",
  reviewed: "",
};

const heading = (r: ChangeRecord) => `${r.vendor} ${r.announcedAt}: ${title(r)}${LABELS[r.status]}`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "a, b, c, d, e and 2 more" */
const firstFive = (items: readonly string[]) => `${items.slice(0, 5).join(", ")}${items.length > 5 ? ` and ${items.length - 5} more` : ""}`;

/** The report line for files too large to read, if any. */
export const tooLargeNote = (files: readonly string[] = []) =>
  files.length > 0 ? [`Not checked: ${plural(files.length, "file")} over ${MAX_FILE_BYTES / 1024 / 1024} MB: ${firstFive(files)}.`] : [];

/** Machine-readable form of the hits. */
export function toJson(hits: (Hit | ModelValueHit)[]): object[] {
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
    ...(h.local ? { localAddresses: h.local } : {}),
    ...("model" in h ? { model: h.model } : {}),
  }));
}

/** The matched code on one line, at most 60 characters; "…" marks anything cut off. */
export function snippet(text: string, width = 60): string {
  const line = text.split("\n")[0]!;
  const cut = line.length > width || line.length < text.length;
  return cut ? `${line.slice(0, width - 1).trimEnd()}…` : line;
}

const NOT_CHECKED = "Not checked: request options built elsewhere and passed in as a variable.";

/** 1 for call sites of any change but a candidate: a machine-written candidate nobody has checked should not fail anyone's build. */
export const exitCodeForCheck = (hits: readonly Hit[]): 0 | 1 => (hits.some((h) => h.record.status !== "candidate") ? 1 : 0);

/** One block per vendor change: heading, locations, count, sources. */
function grouped(hits: readonly Hit[], noun: string): string[] {
  const groups = new Map<string, Hit[]>();
  for (const hit of hits) {
    const group = groups.get(hit.record.id);
    if (group) group.push(hit);
    else groups.set(hit.record.id, [hit]);
  }
  const out: string[] = [];
  for (const group of groups.values()) {
    const record = group[0]!.record;
    const locations = group.map((h) => `${h.file}:${h.line}:${h.column}`);
    const width = locations.reduce((w, l) => Math.max(w, l.length), 0) + 2;
    out.push(heading(record));
    group.forEach((h, i) =>
      out.push(`  ${locations[i]!.padEnd(width)}${snippet(h.text)}${h.local ? `  (sent to ${h.local.join(" or ")}; ignore if that server isn't OpenAI)` : ""}`),
    );
    out.push(`  ${plural(group.length, noun)} in ${plural(new Set(group.map((h) => h.file)).size, "file")}`);
    for (const source of record.sources) out.push(`  ${source.url}`);
    out.push("");
  }
  return out;
}

const VALUES_INTRO = [
  "Possibly affected: retiring model names set as model values, not confirmed as call sites.",
  "Check where each one is sent. These do not fail the check.",
];

/** Terminal report, grouped by vendor change, then the model values. Always ends by saying what was and was not covered. */
export function render(hits: Hit[], coverage?: Coverage, values: readonly ModelValueHit[] = []): string {
  const footer = [
    ...(coverage
      ? [`Scanned ${plural(coverage.files, "JavaScript, TypeScript or Python file")} against ${plural(coverage.records, "change record")}.`]
      : []),
    ...(coverage?.foreign
      ? [
          `Left out ${plural(coverage.foreign, "call")} made through another provider's client with the same methods: ${firstFive(coverage.foreignAt ?? [])}.`,
        ]
      : []),
    ...tooLargeNote(coverage?.tooLarge),
    NOT_CHECKED,
  ];
  const section = values.length > 0 ? [...VALUES_INTRO, "", ...grouped(values, "value")] : [];
  if (hits.length === 0) {
    const clean = values.length > 0 ? "No call sites of known vendor changes found." : "No known vendor changes affect this repository.";
    return [clean, "", ...section, ...footer].join("\n");
  }
  const out = [...grouped(hits, "call site"), ...section];
  if (exitCodeForCheck(hits) === 0) out.push("Unreviewed changes are reported but do not fail the check.");
  out.push(...footer);
  return out.join("\n");
}
