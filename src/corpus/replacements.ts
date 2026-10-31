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
const cellText = (html: string) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|nbsp|mdash|#\d{1,6});/g, (_, e: string) => ENTITIES[e] ?? String.fromCodePoint(Number(e.slice(1))))
    .replace(/[‐‑]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
const cells = (row: string) =>
  row
    .split(/<\/tr>/i)[0]!
    .split(/(?=<t[dh][\s>])/i)
    .filter((c) => /^<t[dh]/i.test(c))
    .map((c) => cellText(c.slice(c.indexOf(">") + 1)));

const REPLACEMENT = new Set(["recommended replacement", "substitute model"]);

/** What the page's tables say: each model's replacement cells in page order, newest first, and every table or row not read. */
export type Page = { replacements: Map<string, string[]>; skipped: string[] };

/** The page's deprecation tables: shutdown date first, then the model, any price columns, and the replacement column. */
export function readPage(html: string): Page {
  const replacements = new Map<string, string[]>();
  const skipped: string[] = [];
  for (const table of html.split(/<table[\s>]/i).slice(1)) {
    const [head = [], ...rows] = table.split(/<\/table>/i)[0]!.split(/<tr[\s>]/i).slice(1).map(cells);
    const to = head.findIndex((h) => REPLACEMENT.has(h.toLowerCase()));
    if (head[0]?.toLowerCase() !== "shutdown date" || to < 2) {
      skipped.push(`table headed ${head.join(" | ")}`);
      continue;
    }
    for (const row of rows) {
      const models = row.length === head.length ? cellModels(row[1]!) : undefined;
      if (!models) skipped.push(`row ${row.join(" | ")}`);
      for (const m of models ?? []) replacements.set(m, [...(replacements.get(m) ?? []), row[to]!]);
    }
  }
  return { replacements, skipped };
}

/** A replacement cell as fix.models holds it: one model id is a rename, anything else is for a person. */
function entry(record: ChangeRecord, text: string): Replacement {
  const vendor = vendorName(record.vendor);
  if (text === "" || text === "—" || text === "-") return { human: `${vendor} names no replacement` };
  if (isModel(text)) return { model: text, source: record.sources[0]!.url };
  return { human: `not a plain swap: ${vendor} recommends ${text.replace(/\.+$/, "")}` };
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
      if (seen.has(at.model)) return { human: `the recommended replacements loop back to ${at.model}` };
      seen.add(at.model);
      const after = entry(record, text);
      if ("human" in after) return { human: `${vendorName(record.vendor)} recommends ${at.model}, which also shuts down; ${after.human}` };
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
