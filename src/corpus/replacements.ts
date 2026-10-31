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

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", nbsp: " ", mdash: "\u2014" };
// Tags the page wraps cell text in. Any other tag, such as img or script, refuses the cell.
const INLINE = new Set(["a", "b", "br", "code", "em", "i", "p", "span", "strong", "sub", "sup"]);
const MAX_CELL = 10_000;
// Left after decoding, these refuse the cell: markup, control characters and bidi controls.
const UNSAFE = /[<>\p{Cc}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

/** Entities decoded once, and the page's non-breaking hyphens read as hyphens. */
const decode = (text: string) =>
  text.replace(/&(amp|lt|gt|nbsp|mdash|#\d{1,6});/g, (_, e: string) => ENTITIES[e] ?? String.fromCodePoint(Number(e.slice(1)))).replace(/[\u2010\u2011]/g, "-");

/** A cell's text: each inline tag read as a space, entities decoded once, whitespace collapsed. Undefined for a cell holding anything else. */
export function cellText(html: string): string | undefined {
  if (html.length > MAX_CELL) return undefined;
  let text = "";
  let at = 0;
  for (let open = html.indexOf("<"); open !== -1; open = html.indexOf("<", at)) {
    const close = html.indexOf(">", open);
    const name = close === -1 ? undefined : /^\/?([a-z0-9]+)(?:[\s/]|$)/i.exec(html.slice(open + 1, close))?.[1]?.toLowerCase();
    if (name === undefined || !INLINE.has(name)) return undefined;
    text += `${html.slice(at, open)} `;
    at = close + 1;
  }
  text += html.slice(at);
  const decoded = decode(text)
    .replace(/\s+/g, " ")
    .replace(/\( | (?=[),])/g, (m) => m.trim())
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

/**
 * What the page's tables say: each model's replacement cells in page order, newest first, every table or row not
 * read, and the text of each model row not read, so a detected model it names fails the run.
 */
export type Page = { replacements: Map<string, string[]>; skipped: string[]; unread: { text: string; row: string }[] };

/** The page's deprecation tables: shutdown date first, then the model, any price columns, and the replacement column. */
export function readPage(html: string): Page {
  const replacements = new Map<string, string[]>();
  const skipped: string[] = [];
  const unread: Page["unread"] = [];
  for (const table of html.split(/<table[\s>]/i).slice(1)) {
    const raw = table.split(/<\/table>/i)[0]!.split(/<tr[\s>]/i).slice(1);
    const [head = [], ...rows] = raw.map(cells);
    const to = head.findIndex((h) => h !== undefined && REPLACEMENT.has(h.toLowerCase()));
    if (head[0]?.toLowerCase() !== "shutdown date" || to < 2) {
      skipped.push(`table headed ${head.map((h) => h ?? "(refused)").join(" | ")}`);
      continue;
    }
    for (const [i, row] of rows.entries()) {
      const bad = row.some((c) => c === undefined) || row.length !== head.length;
      const models = bad ? undefined : cellModels(row[1]!);
      for (const m of models ?? []) replacements.set(m, [...(replacements.get(m) ?? []), row[to]!]);
      if (models) continue;
      const why = row.length !== head.length ? `it has ${row.length} cells, the table ${head.length}` : `a cell holds markup, control characters or over ${MAX_CELL} characters`;
      const label = bad ? `row ${i + 1} of the table headed ${head.join(" | ")}, refused: ${why}` : `row ${row.join(" | ")}`;
      skipped.push(label);
      // A row retiring fine-tuning on a model, not calls to it, names the model and is rightly not read.
      if (bad || !/^New fine-tuning training on [a-z0-9._:-]+$/.test(row[1]!)) unread.push({ text: bad ? decode(raw[i + 1]!) : row[1]!, row: label });
    }
  }
  return { replacements, skipped, unread };
}

// One model id and one setting such as "(reasoning.mode: pro)"; any other words get the fixed reason.
const SETTING = /^(\S+) \(([a-z_.]{1,40}: [a-z0-9_.-]{1,40})\)$/;
const isListed = (s: string) => isModel(s) || (s.endsWith("*") && isModel(s.slice(0, -1)));
const either = (ids: string[]) => (ids.length < 3 ? ids.join(" or ") : `${ids.slice(0, -1).join(", ")}, or ${ids.at(-1)}`);
/** The model ids a replacement cell offers as a choice, "a or b" or "a, b, or c", or undefined for any other cell. */
const choice = (text: string) => {
  const ids = text.split(/,? or |, /);
  return ids.length > 1 && ids.every(isListed) ? ids : undefined;
};

/**
 * A replacement cell as fix.models holds it: one model id is a rename. Model ids joined by commas or "or", or one
 * model id with a setting, become a reason built from those parts, each model followed by `retiring` first. Any
 * other cell gets a fixed reason, never its text.
 */
function entry(record: ChangeRecord, text: string, retiring: (id: string) => string[]): Replacement {
  const vendor = vendorName(record.vendor);
  const source = record.sources[0]!.url;
  if (isModel(text)) return { model: text, source };
  if (text === "\u2014") return { human: `${vendor} names no replacement`, source };
  const setting = SETTING.exec(text);
  if (setting && isModel(setting[1]!)) return { human: `not a plain swap: ${vendor} recommends ${retiring(setting[1]!).join(" or ")} with ${setting[2]}`, source };
  const ids = choice(text);
  if (ids) return { human: `not a plain swap: ${vendor} recommends ${either([...new Set(ids.flatMap((id) => retiring(id)))])}`, source };
  return { human: `${vendor} names no single replacement model`, source };
}

const ID_CHAR = /[a-z0-9._:-]/;
/** Whether `text` holds `id` as a whole name, in any case and with invisible characters such as soft hyphens left out. */
function names(text: string, id: string): boolean {
  const plain = text.replace(/\p{Default_Ignorable_Code_Point}/gu, "").toLowerCase();
  for (let at = plain.indexOf(id); at !== -1; at = plain.indexOf(id, at + 1))
    if (!ID_CHAR.test(plain[at - 1] ?? " ") && !ID_CHAR.test(plain[at + id.length] ?? " ")) return true;
  return false;
}

/**
 * A rename only to a model the API lists in `known`, read from the vendor's API spec. A family name the spec lists
 * only as its "-latest" alias, such as omni-moderation, becomes that alias; any other model is for a person.
 */
function listed(r: Replacement, known: ReadonlySet<string>, vendor: string): Replacement {
  if (!("model" in r) || known.has(r.model)) return r;
  if (known.has(`${r.model}-latest`)) return { ...r, model: `${r.model}-latest` };
  return { human: `not a plain swap: ${vendor} recommends ${r.model}, which its API spec does not list`, source: r.source };
}

/**
 * fix.models for every record that detects models, keyed by record id, from the newest row naming each model.
 * A replacement the page retires too is followed to one it does not; one that ends with no plain swap, or loops,
 * becomes `human`, and so does one the API spec does not list. A model a reason offers is followed the same way, or
 * said to retire too. A detected model the page has no row for, or that a row darnit could not read names, is a
 * problem: an older row must not stand in for a newer one darnit could not read.
 */
export function replacementsFor(
  records: readonly ChangeRecord[],
  page: Page,
  known: ReadonlySet<string>,
): { models: Map<string, Record<string, Replacement>>; problems: string[] } {
  const newest = (m: string) => page.replacements.get(m)?.[0];
  // Where the page sends a model a reason offers: itself if it is not retiring, else the models its newest row offers.
  // Each id is worked out once; one met again while its own answer is pending loops, and retires too.
  const sent = new Map<string, string[]>();
  const retiring = (id: string): string[] => {
    const base = id.replace(/\*$/, "");
    const text = newest(base);
    if (text === undefined) return [id];
    if (sent.has(id)) return sent.get(id)!;
    sent.set(id, [`${id} (retiring too)`]);
    const next = isModel(text) ? [text] : choice(text);
    if (next && base === id) sent.set(id, [...new Set(next.flatMap((n) => retiring(n)))]);
    return sent.get(id)!;
  };
  const follow = (record: ChangeRecord, start: Replacement): Replacement => {
    let at = start;
    const seen = new Set<string>();
    while ("model" in at) {
      const text = newest(at.model);
      if (text === undefined) return at;
      if (seen.has(at.model)) return { human: `the recommended replacements loop back to ${at.model}`, source: at.source };
      seen.add(at.model);
      const after = entry(record, text, retiring);
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
    const unread = page.unread.flatMap((u) => ids.filter((m) => names(u.text, m)).map((m) => `${r.id}: ${m} is named in a row darnit could not read, ${u.row.slice(0, 200)}`));
    if (missing.length > 0) problems.push(`${r.id}: the page has no row for ${missing.join(", ")}`);
    problems.push(...unread);
    if (missing.length > 0 || unread.length > 0 || ids.length === 0) continue;
    const vendor = vendorName(r.vendor);
    const entries = ids.map((m) => [m, ReplacementSchema.safeParse(listed(follow(r, entry(r, newest(m)!, retiring)), known, vendor))] as const);
    const long = entries.filter(([, e]) => !e.success).map(([m]) => m);
    if (long.length > 0) problems.push(`${r.id}: the reason for ${long.join(", ")} is not one line of plain words under 200 characters`);
    else models.set(r.id, Object.fromEntries(entries.map(([m, e]) => [m, e.data!])));
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
