import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { firstFive, listFiles, plural, readText, tooLargeNote, vendorClients } from "./detect.js";
import { loadRecords } from "./records/load.js";
import type { ChangeRecord } from "./records/schema.js";
import { findMatches, grammarFor, modelNames, type Match, type Span } from "./scan/astgrep.js";
import { findMentions, isBinary } from "./scan/mentions.js";
import { findModelValues, inside, isTestPath, joined } from "./scan/values.js";

export type Hit = Match & { record: ChangeRecord; file: string };

/** A model name from a record set as a model value, not confirmed as a call site: reported, never failing the check. */
export type ModelValueHit = Hit & { model: string };

/** Any other exact mention of a model name from a record, in any text file: counted, never failing the check. */
export type MentionHit = { file: string; line: number; model: string; record: ChangeRecord };

const recordNames = (r: ChangeRecord) => Object.values(r.detection.astGrepPatterns).flatMap((p) => modelNames(p));

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
export type Coverage = { files: number; records: number; otherFiles?: number; foreign?: number; foreignAt?: string[]; tooLarge?: string[] };

/**
 * Hits for `records` in `files` (relative to `root`), with `modelValues` the model names set as values
 * outside test code, and with `mentions` every other mention of those names in any text file.
 * Files darnit cannot parse are skipped for hits and values.
 */
export async function scan(
  root: string,
  files: readonly string[],
  records: readonly ChangeRecord[],
  { modelValues = false, mentions: withMentions = false } = {},
): Promise<{ hits: Hit[]; scanned: number; otherFiles: number; foreign: Hit[]; tooLarge: string[]; values: ModelValueHit[]; mentions: MentionHit[] }> {
  const hits: Hit[] = [];
  const values: ModelValueHit[] = [];
  const mentions: MentionHit[] = [];
  const byName = new Map(modelValues || withMentions ? records.flatMap((r) => recordNames(r).map((n) => [n, r] as const)) : []);
  const names = new Set(byName.keys());
  // Calls through another provider's client (Groq's SDK, the vendor's SDK pointed elsewhere): never reported.
  const foreign: Hit[] = [];
  const tooLarge: string[] = [];
  let scanned = 0;
  let otherFiles = 0;
  // Known limit: each file is parsed once per record. Fine for a handful of records; index them by vendor as the corpus grows.
  for (const file of files) {
    const grammar = grammarFor(file);
    if (!grammar && !withMentions) continue;
    const text = await readText(join(root, file), (start) => {
      // A binary file is never searched, so it is not listed as left out.
      if (grammar || !isBinary(start)) tooLarge.push(file);
    });
    if (text === undefined) continue;
    if (withMentions && !isBinary(text)) {
      if (!grammar) otherFiles++;
      // Known limit: every mention stays in memory until printed, about 40 bytes each, so around 100M mentions
      // (300 MB of crafted names) exhaust the heap. Store them compactly, or cap each file and keep its count, if that matters.
      for (const m of findMentions(text, names)) mentions.push({ ...m, file, record: byName.get(m.model)! });
    }
    if (!grammar) continue;
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
  // A name already reported on that line as a call site or a value is not mentioned again.
  const key = (file: string, line: number, model: string) => `${file}:${line} ${model}`;
  const listed = new Set([
    ...values.map((v) => key(v.file, v.line, v.model)),
    ...hits.flatMap((h) => findMentions(h.text, new Set(recordNames(h.record))).map((m) => key(h.file, h.line + m.line - 1, m.model))),
  ]);
  return { hits, scanned, otherFiles, foreign, tooLarge, values, mentions: mentions.filter((m) => !listed.has(key(m.file, m.line, m.model))) };
}

/** Every call site in `root` affected by a known vendor change, and what was covered. */
export async function checkReport(root: string): Promise<{ hits: Hit[]; coverage: Coverage; foreign: Hit[]; values: ModelValueHit[]; mentions: MentionHit[] }> {
  const only = await configuredVendors(root);
  const records = (await loadRecords()).map((l) => l.record).filter((r) => !only || only.has(r.vendor));
  const { hits, scanned, otherFiles, foreign, tooLarge, values, mentions } = await scan(root, await listFiles(root), records, { modelValues: true, mentions: true });
  const leftOut = foreign.length > 0 ? { foreign: foreign.length, foreignAt: foreign.map((h) => `${h.file}:${h.line}`) } : {};
  return { hits, foreign, values, mentions, coverage: { files: scanned, records: records.length, otherFiles, ...leftOut, ...(tooLarge.length > 0 ? { tooLarge } : {}) } };
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

/** Machine-readable form of the mentions. */
export const mentionsToJson = (mentions: readonly MentionHit[]) => mentions.map((m) => ({ id: m.record.id, file: m.file, line: m.line, model: m.model }));

/** The `check --json` text in pieces, with `mentions` last: millions of mentions do not fit in one string. */
export function* checkJson(report: object, mentions: readonly MentionHit[]): Generator<string> {
  const empty = JSON.stringify({ ...report, mentions: [] }, null, 2);
  if (mentions.length === 0) {
    yield empty;
    return;
  }
  yield empty.slice(0, -"]\n}".length);
  for (let i = 0; i < mentions.length; i += 1000) {
    const items = mentionsToJson(mentions.slice(i, i + 1000)).map((m) => JSON.stringify(m, null, 2).replaceAll("\n", "\n    "));
    yield `${i > 0 ? "," : ""}\n    ${items.join(",\n    ")}`;
  }
  yield "\n  ]\n}";
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
  "Possibly affected: retired or retiring model names set as model values, not confirmed as call sites.",
  "Check where each one is sent. These do not fail the check.",
];

const MENTIONS_INTRO = [
  "Also mentioned: retired or retiring model names elsewhere, such as docs, config files, tests and comments.",
  "These do not fail the check.",
];
const MENTION_FILES = 20;

/** Mentions counted per file, most first; with `all`, one line per mention. */
function mentionSection(mentions: readonly MentionHit[], all: boolean): string[] {
  const byFile = new Map<string, MentionHit[]>();
  for (const m of mentions) {
    const list = byFile.get(m.file);
    if (list) list.push(m);
    else byFile.set(m.file, [m]);
  }
  const total = `${plural(mentions.length, "mention")} in ${plural(byFile.size, "file")}`;
  if (all) return [...MENTIONS_INTRO, ...mentions.map((m) => `  ${m.file}:${m.line}  ${m.model}`), `  ${total}`, ""];
  const files = [...byFile].sort((a, b) => b[1].length - a[1].length).slice(0, MENTION_FILES);
  const width = files.reduce((w, [f]) => Math.max(w, f.length), 0) + 2;
  const digits = String(files[0]![1].length).length;
  return [
    ...MENTIONS_INTRO,
    ...files.map(([file, ms]) => `  ${file.padEnd(width)}${String(ms.length).padStart(digits)}  ${firstFive([...new Set(ms.map((m) => m.model))])}`),
    ...(byFile.size > MENTION_FILES ? [`  and ${plural(byFile.size - MENTION_FILES, "more file")}`] : []),
    `  ${total}. darnit check --mentions lists each line.`,
    "",
  ];
}

/** Terminal report, grouped by vendor change, then the model values and other mentions. Always ends by saying what was and was not covered. */
export function render(hits: Hit[], coverage?: Coverage, values: readonly ModelValueHit[] = [], mentions: readonly MentionHit[] = [], allMentions = false): string {
  const footer = [
    ...(coverage
      ? [`Scanned ${plural(coverage.files, "JavaScript, TypeScript or Python file")} against ${plural(coverage.records, "change record")}.`]
      : []),
    ...(coverage?.otherFiles && mentions.length > 0 ? [`Also searched ${plural(coverage.otherFiles, "other file")} for retired or retiring model names.`] : []),
    ...(coverage?.foreign
      ? [
          `Left out ${plural(coverage.foreign, "call")} made through another provider's client with the same methods: ${firstFive(coverage.foreignAt ?? [])}.`,
        ]
      : []),
    ...tooLargeNote(coverage?.tooLarge),
    NOT_CHECKED,
  ];
  const section = [...(values.length > 0 ? [...VALUES_INTRO, "", ...grouped(values, "value")] : []), ...(mentions.length > 0 ? mentionSection(mentions, allMentions) : [])];
  if (hits.length === 0) {
    const clean = section.length > 0 ? "No call sites of known vendor changes found." : "No known vendor changes affect this repository.";
    return [clean, "", ...section, ...footer].join("\n");
  }
  const out = [...grouped(hits, "call site"), ...section];
  if (exitCodeForCheck(hits) === 0) out.push("Unreviewed changes are reported but do not fail the check.");
  out.push(...footer);
  return out.join("\n");
}
