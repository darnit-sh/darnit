import { vendorName } from "../detect.js";
import { ModelId, recordModels, ReplacementSchema, type ChangeRecord, type Replacement } from "../records/schema.js";

// fix.models for each model record, from the vendor's deprecations page, with each record's notes as a cross-check.
// Page and notes are data: read as text, never turned into code, paths or patterns.

const START = "Recommended replacements: ";
const END = ". A newer model can answer differently";

/** Each model the notes name a replacement for, with the replacement as written. Throws on notes it cannot read whole. */
export function recommended(migration: string): Map<string, string> {
  const out = new Map<string, string>();
  const at = migration.indexOf(START);
  if (at === -1) return out;
  const end = migration.indexOf(END, at);
  if (end === -1) throw new Error(`the replacements do not end with "${END.slice(2)}"`);
  for (const entry of migration.slice(at + START.length, end).split("; ")) {
    const to = entry.indexOf(" to ");
    if (to <= 0) throw new Error(`cannot read "${entry}" as "<model> to <replacement>"`);
    const old = entry.slice(0, to);
    if (out.has(old)) throw new Error(`${old} is named twice`);
    out.set(old, entry.slice(to + 4).trim());
  }
  return out;
}

const isModel = (s: string) => ModelId.safeParse(s).success;
const allModels = (parts: string[]) => (parts.every(isModel) ? parts : undefined);

/** The model ids in a table's model cell, or undefined for a row about something else, such as an endpoint, a header or an API. */
export function cellModels(text: string): string[] | undefined {
  // "gpt-5", or a snapshot and the aliases pointing to it: "gpt-4-0613 | gpt-4, gpt-4-completions".
  const listed = allModels(text.split(/\s*[|,]\s*/));
  if (listed) return listed;
  // "GPT-4o (gpt-4o-2024-08-06, gpt-4o-2024-11-20)", "gpt-4-0125-preview (including a and b, which point to this snapshot)".
  // A family name stands for its alias: GPT-4o is gpt-4o, GPT-4o mini is gpt-4o-mini. Anything else, such as "Assistants API (v1)", is no model.
  const open = text.indexOf(" (");
  const name = text.slice(0, open).toLowerCase().replaceAll(" ", "-");
  if (open === -1 || !text.endsWith(")") || !isModel(name) || !/\d/.test(name)) return undefined;
  const inner = text.slice(open + 2, -1).replace(/^including /, "").replace(/,? which point to this snapshot$/, "");
  const ids = allModels(inner.split(/,\s*|\s+and\s+/));
  return ids && [name, ...ids];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', nbsp: " ", mdash: "—" };
// Tags the page wraps cell text in. Any other tag, such as img or script, refuses the cell.
const INLINE = new Set(["a", "b", "br", "code", "em", "i", "p", "span", "strong", "sub", "sup"]);
const MAX_CELL = 10_000;
// Left after decoding, these refuse the cell: markup, control characters and bidi controls.
const UNSAFE = /[<>\p{Cc}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

/** A cell's text: inline tags skipped, entities decoded once, whitespace collapsed. Undefined for a cell holding anything else. */
export function cellText(html: string): string | undefined {
  if (html.length > MAX_CELL) return undefined;
  let text = "";
  let at = 0;
  for (let open = html.indexOf("<"); open !== -1; open = html.indexOf("<", at)) {
    const close = html.indexOf(">", open);
    const name = close === -1 ? undefined : /^\/?([a-z0-9]+)(?:[\s/]|$)/i.exec(html.slice(open + 1, close))?.[1]?.toLowerCase();
    if (name === undefined || !INLINE.has(name)) return undefined;
    text += html.slice(at, open);
    at = close + 1;
  }
  text += html.slice(at);
  const decoded = text
    .replace(/&(amp|lt|gt|quot|nbsp|mdash|#\d{1,6});/g, (_, e: string) => ENTITIES[e] ?? String.fromCodePoint(Number(e.slice(1))))
    .replace(/\s+/g, " ")
    .replace(/[\u2010\u2011]/g, "-")
    .trim();
  return UNSAFE.test(decoded) ? undefined : decoded;
}
const cells = (row: string) =>
  row
    .split(/<\/tr>/i)[0]!
    .split(/(?=<t[dh][\s>])/i)
    .filter((c) => /^<t[dh]/i.test(c))
    .map((c) => cellText(c.slice(c.indexOf(">") + 1).split(/<\/t[dh]\s*>/i)[0]!));

const REPLACEMENT = new Set(["recommended replacement", "substitute model"]);

/** What the page's tables say: each model's replacement cells in page order, newest first, and every table or row not read. */
export type Page = { replacements: Map<string, string[]>; skipped: string[] };

/** The page's deprecation tables: shutdown date first, then the model, any price columns, and the replacement column. */
export function readPage(html: string): Page {
  const replacements = new Map<string, string[]>();
  const skipped: string[] = [];
  for (const table of html.split(/<table[\s>]/i).slice(1)) {
    const [head = [], ...rows] = table.split(/<\/table>/i)[0]!.split(/<tr[\s>]/i).slice(1).map(cells);
    const to = head.findIndex((h) => h !== undefined && REPLACEMENT.has(h.toLowerCase()));
    if (head[0]?.toLowerCase() !== "shutdown date" || to < 2) {
      skipped.push(`table headed ${head.map((h) => h ?? "(refused)").join(" | ")}`);
      continue;
    }
    for (const row of rows) {
      const refused = row.some((c) => c === undefined);
      const models = refused || row.length !== head.length ? undefined : cellModels(row[1]!);
      if (!models) skipped.push(refused ? `row refused: a cell holds markup, control characters or over ${MAX_CELL} characters` : `row ${row.join(" | ")}`);
      for (const m of models ?? []) replacements.set(m, [...(replacements.get(m) ?? []), row[to]!]);
    }
  }
  return { replacements, skipped };
}

const SETTING = /^(\S+) \(([A-Za-z0-9._: -]{1,60})\)$/;

/**
 * A replacement cell as fix.models holds it: one model id is a rename. Model ids joined by commas or "or", or one
 * model id with a setting, become a reason built from those parts. Any other cell gets a fixed reason, never its text.
 */
function entry(record: ChangeRecord, text: string): Replacement {
  const vendor = vendorName(record.vendor);
  const source = record.sources[0]!.url;
  if (isModel(text)) return { model: text, source };
  if (text === "" || text === "—" || text === "-") return { human: `${vendor} names no replacement`, source };
  const setting = text.length <= 200 ? SETTING.exec(text) : null;
  if (setting && isModel(setting[1]!)) return { human: `not a plain swap: ${vendor} recommends ${setting[1]} with ${setting[2]}`, source };
  const ids = text.length <= 200 ? text.split(/,? or |, /) : [];
  if (ids.length > 1 && ids.every(isModel)) return { human: `not a plain swap: ${vendor} recommends one of ${ids.join(", ")}`, source };
  return { human: `${vendor} names no single replacement model`, source };
}

/**
 * fix.models for every record that detects models, keyed by record id, from the newest row naming each model.
 * A replacement the page retires too is followed to one it does not; one that ends with no plain swap, or loops,
 * becomes `human`. A detected model the page has no row for is a problem.
 */
export function replacementsFor(records: readonly ChangeRecord[], page: Page): { models: Map<string, Record<string, Replacement>>; problems: string[] } {
  const newest = (m: string) => page.replacements.get(m)?.[0];
  const follow = (record: ChangeRecord, start: Replacement): Replacement => {
    let at = start;
    const seen = new Set<string>();
    while ("model" in at) {
      const text = newest(at.model);
      if (text === undefined) return at;
      if (seen.has(at.model)) return { human: `the recommended replacements loop back to ${at.model}`, source: at.source };
      seen.add(at.model);
      const after = entry(record, text);
      if ("human" in after) return { human: `${vendorName(record.vendor)} recommends ${at.model}, which also shuts down; ${after.human}`, source: after.source };
      at = after;
    }
    return at;
  };
  const models = new Map<string, Record<string, Replacement>>();
  const problems: string[] = [];
  for (const r of records) {
    const ids = recordModels(r);
    const missing = ids.filter((m) => newest(m) === undefined);
    if (missing.length > 0) problems.push(`${r.id}: the page has no row for ${missing.join(", ")}`);
    else if (ids.length > 0) models.set(r.id, Object.fromEntries(ids.map((m) => [m, ReplacementSchema.parse(follow(r, entry(r, newest(m)!)))])));
  }
  return { models, problems };
}

/** Where a record's notes disagree with the page's newest row for a model, or name a model the record does not detect. */
export function pageMismatches(records: readonly ChangeRecord[], page: Page): string[] {
  const out: string[] = [];
  for (const r of records) {
    const ids = recordModels(r);
    for (const [m, said] of recommended(r.notes?.migration ?? "")) {
      const newest = page.replacements.get(m)?.[0];
      if (!ids.includes(m)) out.push(`${r.id}: the notes name ${m}, which the record does not detect`);
      else if (newest !== said) out.push(`${r.id}: notes say ${m} to ${said}, the page says ${newest ?? "nothing"}`);
    }
  }
  return out;
}
