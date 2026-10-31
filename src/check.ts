import { join } from "node:path";
import { parse, type SgNode } from "@ast-grep/napi";
import { parse as parseYaml } from "yaml";
import { byPath, firstFive, listFiles, plural, readText, shown, skippedNote, tooLargeNote, vendorClients, vendorName, type Skipped } from "./detect.js";
import { loadRecords } from "./records/load.js";
import { recordModels, type ChangeRecord, type Replacement } from "./records/schema.js";
import { findMatches, grammarFor, type Match, type Span } from "./scan/astgrep.js";
import { findMentions, isBinary } from "./scan/mentions.js";
import { findModelValues, inside, isTestPath, joined } from "./scan/values.js";

export type Hit = Match & { record: ChangeRecord; file: string };

/** A model name from a record set as a model value, not confirmed as a call site: reported, never failing the check. */
export type ModelValueHit = Hit & { model: string };

/** Any other exact mention of a model name from a record, in any text file: counted, never failing the check. */
export type MentionHit = { file: string; line: number; model: string; record: ChangeRecord };

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
export type Coverage = { files: number; records: number; otherFiles?: number; foreign?: number; foreignAt?: string[]; tooLarge?: string[]; skipped?: Skipped[] };

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
): Promise<{ hits: Hit[]; scanned: number; otherFiles: number; foreign: Hit[]; tooLarge: string[]; unreadable: string[]; values: ModelValueHit[]; mentions: MentionHit[] }> {
  const hits: Hit[] = [];
  const values: ModelValueHit[] = [];
  const mentions: MentionHit[] = [];
  const namesOf = new Map(records.map((r) => [r, new Set(recordModels(r))]));
  // Every record naming a model: a value or mention is listed under each, the same way call sites are.
  const byName = new Map<string, ChangeRecord[]>();
  for (const r of modelValues || withMentions ? records : []) for (const n of namesOf.get(r)!) byName.set(n, [...(byName.get(n) ?? []), r]);
  const names = new Set(byName.keys());
  // Calls through another provider's client (Groq's SDK, the vendor's SDK pointed elsewhere): never reported.
  const foreign: Hit[] = [];
  const tooLarge: string[] = [];
  const unreadable: string[] = [];
  let scanned = 0;
  let otherFiles = 0;
  for (const file of files) {
    const grammar = grammarFor(file);
    if (!grammar && !withMentions) continue;
    let large = false;
    const text = await readText(join(root, file), (start) => {
      large = true;
      // A binary file is never searched, so it is not listed as left out.
      if (grammar || !isBinary(start)) tooLarge.push(file);
    });
    if (text === undefined) {
      if (!large) unreadable.push(file);
      continue;
    }
    if (withMentions && !isBinary(text)) {
      if (!grammar) otherFiles++;
      // Known limit: every mention stays in memory until printed, about 40 bytes each, so around 100M mentions
      // (300 MB of crafted names) exhaust the heap. Store them compactly, or cap each file and keep its count, if that matters.
      for (const m of findMentions(text, names, file)) for (const record of byName.get(m.model)!) mentions.push({ ...m, file, record });
    }
    if (!grammar) continue;
    scanned++;
    // Parsed at most once, when a record needs it; every record shares the tree and the client index built on it.
    let tree: SgNode | undefined;
    const parsed = () => (tree ??= parse(grammar.grammar, text).root());
    const reported = new Map<string, Span[]>();
    for (const record of records) {
      const patterns = record.detection.astGrepPatterns[grammar.lang];
      if (!patterns) continue;
      const { sdkSymbols: symbols, endpoints } = record.surface;
      const vendor = vendorClients(record.vendor);
      for (const match of findMatches(text, grammar.grammar, patterns, { symbols, endpoints, vendor }, parsed)) {
        (match.foreign ? foreign : hits).push({ ...match, record, file });
        const spans = reported.get(record.id);
        if (spans) spans.push(match.span);
        else reported.set(record.id, [match.span]);
      }
      // Nodes read from the tree free their memory only once the scan yields, so a big file holds one record's at a time, not every record's.
      // Small files skip it: yielding after every record costs more time than their nodes cost memory.
      if (tree && text.length > 100_000) await new Promise((r) => setImmediate(r));
    }
    if (names.size === 0 || isTestPath(file)) continue;
    // A value inside a call site reported for a record naming that model is already listed there.
    const covered = new Map([...reported].map(([id, spans]) => [id, joined(spans)]));
    for (const v of findModelValues(file, text, grammar.grammar, names, parsed)) {
      const named = byName.get(v.model)!;
      if (!named.some((r) => inside(covered.get(r.id) ?? [], v.span.start, v.span.end))) for (const record of named) values.push({ ...v, record, file });
    }
  }
  // A name already reported on that line, as a call site or a value, is not mentioned again.
  const key = (file: string, line: number, model: string) => `${file}:${line} ${model}`;
  const listed = new Set([
    ...values.map((v) => key(v.file, v.line, v.model)),
    ...hits.flatMap((h) => findMentions(h.text, namesOf.get(h.record)!, h.file).map((m) => key(h.file, h.line + m.line - 1, m.model))),
  ]);
  return { hits, scanned, otherFiles, foreign, tooLarge, unreadable, values, mentions: mentions.filter((m) => !listed.has(key(m.file, m.line, m.model))) };
}

/** Every call site in `root` affected by a known vendor change, and what was covered. */
export async function checkReport(root: string): Promise<{ hits: Hit[]; coverage: Coverage; foreign: Hit[]; values: ModelValueHit[]; mentions: MentionHit[] }> {
  const only = await configuredVendors(root);
  const records = (await loadRecords()).map((l) => l.record).filter((r) => !only || only.has(r.vendor));
  const skipped: Skipped[] = [];
  const { hits, scanned, otherFiles, foreign, tooLarge, unreadable, values, mentions } = await scan(root, await listFiles(root, skipped), records, {
    modelValues: true,
    mentions: true,
  });
  skipped.push(...unreadable.map((path) => ({ path, reason: "could not be read" as const })));
  skipped.sort(byPath);
  const leftOut = foreign.length > 0 ? { foreign: foreign.length, foreignAt: foreign.map((h) => `${h.file}:${h.line}`) } : {};
  return { hits, foreign, values, mentions, coverage: { files: scanned, records: records.length, otherFiles, ...leftOut, ...(tooLarge.length > 0 ? { tooLarge } : {}), ...(skipped.length > 0 ? { skipped } : {}) } };
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

const modelSets = new WeakMap<object, Set<string>>();

/** The record's replacement for the retiring model a finding names: a call site or value names one. */
export function replacement(h: Hit | ModelValueHit): Replacement | undefined {
  const models = h.record.fix?.models;
  if (!models) return undefined;
  if (!modelSets.has(models)) modelSets.set(models, new Set(Object.keys(models)));
  const model = "model" in h ? h.model : findMentions(h.text, modelSets.get(models)!, h.file)[0]?.model;
  return model !== undefined && Object.hasOwn(models, model) ? models[model] : undefined;
}

const advice = (r: Replacement, vendor: string) => ("model" in r ? `use ${shown(r.model)} instead (${vendorName(vendor)}'s recommendation)` : shown(r.human));

const heading = (r: ChangeRecord) => `${r.vendor} ${r.announcedAt}: ${title(r)}${LABELS[r.status]}`;

/** Machine-readable form of the hits. */
export function toJson(hits: readonly (Hit | ModelValueHit)[]): object[] {
  return hits.map((h) => {
    const swap = replacement(h);
    return {
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
      ...(swap ? { replacement: swap } : {}),
    };
  });
}

/** Machine-readable form of the mentions. */
export const mentionsToJson = (mentions: readonly MentionHit[]) => mentions.map((m) => ({ id: m.record.id, file: m.file, line: m.line, model: m.model }));

/** `items` as a JSON array one level inside the report, in pieces of 1000. */
function* jsonArray<T>(items: readonly T[], toObjects: (items: readonly T[]) => object[]): Generator<string> {
  if (items.length === 0) {
    yield "[]";
    return;
  }
  yield "[";
  for (let i = 0; i < items.length; i += 1000) {
    const parts = toObjects(items.slice(i, i + 1000)).map((m) => JSON.stringify(m, null, 2).replaceAll("\n", "\n    "));
    yield `${i > 0 ? "," : ""}\n    ${parts.join(",\n    ")}`;
  }
  yield "\n  ]";
}

/** The `check --json` text in pieces, with the lists last: millions of hits or mentions do not fit in one string. */
export function* checkJson(
  report: object,
  { hits, possiblyAffected, mentions }: { hits: readonly Hit[]; possiblyAffected: readonly ModelValueHit[]; mentions: readonly MentionHit[] },
): Generator<string> {
  yield JSON.stringify(report, null, 2).slice(0, -"\n}".length);
  for (const [key, list] of [
    ["hits", jsonArray(hits, toJson)],
    ["possiblyAffected", jsonArray(possiblyAffected, toJson)],
    ["mentions", jsonArray(mentions, mentionsToJson)],
  ] as const) {
    yield `,\n  "${key}": `;
    yield* list;
  }
  yield "\n}";
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
    const locations = group.map((h) => `${shown(h.file)}:${h.line}:${h.column}`);
    const width = locations.reduce((w, l) => Math.max(w, l.length), 0) + 2;
    out.push(heading(record));
    group.forEach((h, i) => {
      out.push(`  ${locations[i]!.padEnd(width)}${snippet(h.text)}${h.local ? `  (sent to ${h.local.map(shown).join(" or ")}; ignore if that server isn't OpenAI)` : ""}`);
      const swap = replacement(h);
      if (swap) out.push(`    ${advice(swap, record.vendor)}`);
    });
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

/** Mentions counted per file, most first; with `all`, one line per mention. A mention named by two records is counted once. */
function mentionSection(listed: readonly MentionHit[], all: boolean): string[] {
  // One entry per record naming the model, side by side: keep the first.
  const mentions = listed.filter((m, i) => i === 0 || m.line !== listed[i - 1]!.line || m.model !== listed[i - 1]!.model || m.file !== listed[i - 1]!.file);
  const byFile = new Map<string, MentionHit[]>();
  for (const m of mentions) {
    const list = byFile.get(m.file);
    if (list) list.push(m);
    else byFile.set(m.file, [m]);
  }
  const total = `${plural(mentions.length, "mention")} in ${plural(byFile.size, "file")}`;
  if (all) return [...MENTIONS_INTRO, ...mentions.map((m) => `  ${shown(m.file)}:${m.line}  ${m.model}`), `  ${total}`, ""];
  const files = [...byFile].sort((a, b) => b[1].length - a[1].length).slice(0, MENTION_FILES).map(([file, ms]) => [shown(file), ms] as const);
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

/** One "Not checked" line per reason the scan left files or folders unread. */
export const notCheckedNotes = (coverage?: Coverage) => [...tooLargeNote(coverage?.tooLarge), ...skippedNote(coverage?.skipped)];

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
    ...notCheckedNotes(coverage),
    NOT_CHECKED,
  ];
  const section = [...(values.length > 0 ? [...VALUES_INTRO, "", ...grouped(values, "value")] : []), ...(mentions.length > 0 ? mentionSection(mentions, allMentions) : [])];
  if (hits.length === 0) {
    // "Nothing affects this repository" only when nothing was left unread.
    const partial = section.length > 0 || (coverage?.skipped?.length ?? 0) > 0 || (coverage?.tooLarge?.length ?? 0) > 0;
    const clean = partial ? "No call sites of known vendor changes found." : "No known vendor changes affect this repository.";
    return [clean, "", ...section, ...footer].join("\n");
  }
  const out = [...grouped(hits, "call site"), ...section];
  if (exitCodeForCheck(hits) === 0) out.push("Unreviewed changes are reported but do not fail the check.");
  out.push(...footer);
  return out.join("\n");
}
