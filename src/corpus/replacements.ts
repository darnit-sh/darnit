import { vendorName } from "../detect.js";
import { ModelId, recordModels, ReplacementSchema, type ChangeRecord, type Replacement } from "../records/schema.js";

// fix.models for each model record, from the replacements its notes copy out of the vendor's deprecations page.
// Notes and page are data: read with indexOf and slice, never turned into code, paths or patterns.

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

/** The replacement a record names for `old`, before following it into other records. */
function direct(record: ChangeRecord, text: string | undefined): Replacement {
  const vendor = vendorName(record.vendor);
  if (text === undefined) return { human: `${vendor} names no replacement` };
  if (ModelId.safeParse(text).success) return { model: text, source: record.sources[0]!.url };
  return { human: `not a plain swap: ${vendor} recommends ${text.replace(/\.+$/, "")}` };
}

/**
 * fix.models for every record that detects models, keyed by record id. A replacement that another record
 * retires is followed to one no record retires; one that ends with no plain swap, or loops, becomes `human`.
 */
export function replacementsFor(records: readonly ChangeRecord[]): Map<string, Record<string, Replacement>> {
  const named = new Map<string, Map<string, string>>();
  const retired = new Map<string, Replacement>();
  for (const r of records) {
    const models = recordModels(r);
    if (models.length === 0) continue;
    const notes = recommended(r.notes?.migration ?? "");
    const unknown = [...notes.keys()].filter((m) => !models.includes(m));
    if (unknown.length > 0) throw new Error(`${r.id}: the notes name ${unknown.join(", ")}, which the record does not detect`);
    named.set(r.id, notes);
    for (const m of models) retired.set(m, direct(r, notes.get(m)));
  }
  const follow = (first: Replacement): Replacement => {
    let next = first;
    const seen = new Set<string>();
    while ("model" in next && retired.has(next.model)) {
      if (seen.has(next.model)) return { human: `the recommended replacements loop back to ${next.model}` };
      seen.add(next.model);
      const after = retired.get(next.model)!;
      if ("human" in after) return { human: `${next.model}, the recommended replacement, also shuts down: ${after.human}` };
      next = after;
    }
    return next;
  };
  const out = new Map<string, Record<string, Replacement>>();
  for (const r of records) {
    if (!named.has(r.id)) continue;
    const models = Object.fromEntries(recordModels(r).map((m) => [m, ReplacementSchema.parse(follow(retired.get(m)!))]));
    out.set(r.id, models);
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', nbsp: " ", mdash: "—" };
const cellText = (html: string) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|nbsp|mdash|#\d{1,6});/g, (_, e: string) => ENTITIES[e] ?? String.fromCodePoint(Number(e.slice(1))))
    .replace(/\s+/g, " ")
    .trim();

/** Each model in the page's tables with the replacements its rows name: model in the second cell, replacement in the last. */
export function pageRows(html: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of html.split(/<tr[\s>]/i).slice(1)) {
    const cells = row
      .split(/<\/tr>/i)[0]!
      .split(/(?=<t[dh][\s>])/i)
      .filter((c) => /^<t[dh]/i.test(c))
      .map((c) => cellText(c.slice(c.indexOf(">") + 1)));
    if (cells.length < 3) continue;
    out.set(cells[1]!, [...(out.get(cells[1]!) ?? []), cells.at(-1)!]);
  }
  return out;
}

/** Where a record's notes and the page disagree: a replacement the page does not give, or one the notes leave out. */
export function pageMismatches(records: readonly ChangeRecord[], rows: Map<string, string[]>): string[] {
  const out: string[] = [];
  for (const r of records) {
    const notes = recommended(r.notes?.migration ?? "");
    for (const m of recordModels(r)) {
      const page = (rows.get(m) ?? []).filter((t) => t !== "" && t !== "—" && t !== "-");
      const said = notes.get(m);
      if (said !== undefined && !page.includes(said)) out.push(`${r.id}: notes say ${m} to ${said}, the page says ${page.join(" | ") || "nothing"}`);
      if (said === undefined && page.length > 0) out.push(`${r.id}: the page says ${m} to ${page.join(" | ")}, the notes name none`);
    }
  }
  return out;
}
