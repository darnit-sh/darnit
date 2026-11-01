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

// Named entities the page uses, decoded; any other is left, so a fold holding it fails closed.
// The page writes "no replacement" as an em dash, decoded from &mdash; to this.
const EM_DASH = "\u2014";
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", shy: "\u00ad", hyphen: "\u2010", ndash: "\u2013", mdash: EM_DASH, rsquo: "\u2019", rdquo: "\u201d" };
// Tags the page wraps cell text in. Any other tag, such as img or script, refuses the cell.
const INLINE = new Set(["a", "b", "br", "code", "em", "i", "p", "span", "strong", "sub", "sup"]);
const MAX_CELL = 10_000;
// Left after decoding, these refuse the cell: markup, control characters and bidi controls.
const UNSAFE = /[<>\p{Cc}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

/** References decoded once: hex and decimal of any length, with or without ";", and the named ones above. The page's non-breaking hyphens read as hyphens. */
const decode = (text: string) =>
  text
    .replace(/&#(?:[xX]([0-9a-fA-F]+)|(\d+));?|&([a-zA-Z]+);/g, (ref: string, hex?: string, dec?: string, name?: string) => {
      if (name !== undefined) return NAMED[name] ?? ref;
      const code = hex !== undefined ? Number.parseInt(hex, 16) : Number(dec);
      return code <= 0x10ffff ? String.fromCodePoint(code) : ref;
    })
    .replace(/[\u2010\u2011]/g, "-");

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
/** Markup's text with each tag left out, from a "<" to the next ">", and references decoded once. */
function untag(html: string): string {
  let text = "";
  let at = 0;
  for (let open = html.indexOf("<"); open !== -1; open = html.indexOf("<", at)) {
    const close = html.indexOf(">", open);
    text += html.slice(at, open);
    at = close === -1 ? html.length : close + 1;
  }
  return decode(text + html.slice(at));
}

/** The letters and digits a person reads in markup, lower case. */
export const fold = (html: string) => untag(html).toLowerCase().replace(/[^a-z0-9]/g, "");

// The structure darnit reads a table in, each in the parent it may open in. Only <table> takes an attribute, its class.
const PARENTS: Record<string, readonly (string | undefined)[]> = { table: [undefined], thead: ["table"], tbody: ["table"], tr: ["table", "thead", "tbody"], td: ["tr"], th: ["tr"] };
// Every table-structure token on the page; each must be one darnit read as a table a browser shows.
const STRUCTURE = /<\/?(?:table|thead|tbody|tfoot|tr|td|th|caption|colgroup|col)(?=[\s/>])/gi;
// A token in a table: a tag with double-quoted attribute values, a comment whose body holds no ">", a reference, or text.
const TOKEN = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z][a-zA-Z0-9_:.-]*="[^"<>]*")*)\s*>|<!--(?!-?>)[^>]*-->|&(?:#[xX][0-9a-fA-F]+;?|#\d+;?|([a-zA-Z]+);)|[^<&]+/y;
// After decoding, a table holding these is not read as a person would: a & or <, or a letter, digit or mark outside ASCII.
const UNREADABLE = /[&<]|(?![\0-\x7f])[\p{L}\p{N}\p{M}]/u;

/**
 * A table starting at `start`, read strictly: the structure above in matching pairs, the inline tags inside cells
 * with at most a class (and an href on a link), comments, references darnit decodes, and whitespace between cells.
 * Anything else is an error: an unclosed or mismatched tag, `</th>` closing a `<td>`, a `rowspan`, `hidden` or `style`.
 */
function parseTable(html: string, start: number): { end: number; marks: number[]; rows: { markup: string; cells: string[] }[]; error?: string } {
  const [stack, marks, rows]: [string[], number[], { markup: string; cells: string[] }[]] = [[], [], []];
  let row = { start: 0, cells: [] as string[] };
  let cell = 0;
  for (let at = start; at < html.length; at = TOKEN.lastIndex) {
    TOKEN.lastIndex = at;
    const [token = "", slash, tag, attrs = "", ref] = TOKEN.exec(html) ?? [];
    const name = tag?.toLowerCase();
    const inCell = stack.includes("td") || stack.includes("th");
    const names = [...attrs.matchAll(/\s+([^\s=]+)=/g)].map((a) => a[1]!.toLowerCase());
    const ok =
      token === ""
        ? false
        : name === undefined
          ? token.startsWith("<!--") || (inCell && (!token.startsWith("&") || ref === undefined || Object.hasOwn(NAMED, ref))) || token.trim() === ""
          : slash
            ? attrs === "" && stack.at(-1) === name
            : name in PARENTS
              ? PARENTS[name]!.includes(stack.at(-1)) && names.every((a) => name === "table" && a === "class")
              : inCell && INLINE.has(name) && names.every((a) => a === "class" || (name === "a" && a === "href"));
    if (!ok) return { end: at, marks, rows, error: `it holds markup darnit does not read in a table at offset ${at}` };
    if (name === undefined) continue;
    if (name in PARENTS) marks.push(at);
    if (!slash && name !== "br") stack.push(name);
    if (!slash && name === "tr") row = { start: at, cells: [] };
    if (!slash && (name === "td" || name === "th")) cell = TOKEN.lastIndex;
    if (slash) stack.pop();
    if (slash && (name === "td" || name === "th")) row.cells.push(html.slice(cell, at));
    if (slash && name === "tr") rows.push({ markup: html.slice(row.start, TOKEN.lastIndex), cells: row.cells });
    if (slash && name === "table") return { end: TOKEN.lastIndex, marks, rows };
  }
  return { end: html.length, marks, rows, error: "it has no end" };
}

// Elements whose content a browser does not show as markup of the page. The first ones hold raw text, so the first end
// tag closes them; the others nest.
const RAW = ["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"];
const HIDDEN = new Map([...RAW, "template", "svg", "math", "select", "object"].map((n) => [n, new RegExp(`<(/?)${n}(?=[\\s/>])`, "gi")]));

/** Where the tag at `open` ends, past quoted attribute values, or -1 when it does not. */
function tagEnd(html: string, open: number): number {
  let quote = "";
  for (let i = open + 1; i < html.length; i++) {
    const c = html[i]!;
    if (quote) quote = c === quote ? "" : quote;
    else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i + 1;
  }
  return -1;
}

/**
 * The offset of the next table a browser shows, past comments, tags with their attribute values, and hidden elements'
 * content; -1 when there is none, or where darnit cannot follow the page, so no table after it is read.
 */
function nextTable(html: string, from: number): number {
  for (let at = from; ; ) {
    const open = html.indexOf("<", at);
    if (open === -1) return -1;
    const name = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(open, open + 40))?.[1]?.toLowerCase();
    if (name === "table") return open;
    const comment = html.startsWith("<!--", open) ? html.indexOf("-->", open + 4) : undefined;
    if (comment !== undefined) at = comment === -1 ? -1 : comment + 3;
    else if (name === undefined && !/^<[/!?]/.test(html.slice(open, open + 2))) at = open + 1;
    else at = name === "plaintext" ? -1 : tagEnd(html, open);
    const hidden = name === undefined ? undefined : HIDDEN.get(name);
    if (at > 0 && hidden && html[at - 2] !== "/") {
      let depth = 1;
      let tag: RegExpExecArray | null = null;
      for (hidden.lastIndex = at; depth > 0 && (tag = hidden.exec(html)); ) depth += tag[1] ? -1 : RAW.includes(name!) ? 0 : 1;
      at = depth > 0 || !tag ? -1 : tagEnd(html, tag.index);
    }
    if (at <= 0) return -1;
  }
}

const REPLACEMENT = new Set(["recommended replacement", "substitute model"]);

/**
 * A `<tr>` of a table darnit read, folded, with what darnit read from it: the models in its model cell and the models
 * its replacement offers. `exempt` is the model a row retiring fine-tuning on it names.
 */
export type Row = { label: string; folded: string; read: string[]; exempt?: string };

/** A table of the page, folded, and why darnit does not read it as a person would, if it does not. */
export type Table = { label: string; folded: string; error?: string };

/**
 * What the page's tables say: each model's replacement cells in page order, newest first, every table, every row of
 * the tables darnit read, and every table-structure token darnit did not read as part of a table a browser shows.
 */
export type Page = { replacements: Map<string, string[]>; tables: Table[]; rows: Row[]; problems: string[] };

/**
 * The page's deprecation tables: shutdown date first, then the model, any price columns, and the replacement column.
 * A table darnit cannot read strictly is passed over to its first </table> and reported, never read.
 */
export function readPage(html: string): Page {
  const replacements = new Map<string, string[]>();
  const [tables, rows, read]: [Table[], Row[], Set<number>] = [[], [], new Set()];
  for (let at = nextTable(html, 0); at !== -1; ) {
    const label = `table ${tables.length + 1}`;
    const parsed = parseTable(html, at);
    const close = parsed.error ? /<\/table\s*>/gi : undefined;
    if (close) close.lastIndex = at;
    const end = close ? (close.exec(html) ? close.lastIndex : html.length) : parsed.end;
    const markup = html.slice(at, end);
    const error = parsed.error ?? (UNREADABLE.test(untag(markup)) ? "it holds a reference or a letter darnit cannot read as a person would" : undefined);
    tables.push({ label, folded: fold(markup), ...(error ? { error } : {}) });
    for (const m of parsed.error ? markup.matchAll(STRUCTURE) : []) read.add(at + m.index);
    for (const m of parsed.error ? [] : parsed.marks) read.add(m);
    const [head = [], ...body] = parsed.error ? [] : parsed.rows.map((r) => r.cells.map(cellText));
    const to = head[0]?.toLowerCase() === "shutdown date" && head.every((h) => h !== undefined) ? head.findIndex((h) => REPLACEMENT.has(h.toLowerCase())) : -1;
    for (const [i, raw] of (parsed.error ? [] : parsed.rows).entries()) {
      const cells = i === 0 ? [] : body[i - 1]!;
      let found: string[] = [];
      let exempt: string | undefined;
      if (i > 0 && to >= 2 && cells.length === head.length && cells.every((c) => c !== undefined)) {
        const models = cellModels(cells[1]!);
        for (const m of models ?? []) replacements.set(m, [...(replacements.get(m) ?? []), cells[to]!]);
        // A row retiring fine-tuning on a model, not calls to it: exempt when that is a real model.
        exempt = models ? undefined : /^New fine-tuning training on ([a-z0-9._:-]+)$/.exec(cells[1]!)?.[1];
        if (models || exempt) found = [...(models ?? []), ...offered(cells[to]!)];
      }
      rows.push({ label: `${label} row ${i + 1}`, folded: fold(raw.markup), read: found, ...(exempt ? { exempt } : {}) });
    }
    at = nextTable(html, end);
  }
  const problems = [...html.matchAll(STRUCTURE)].filter((m) => !read.has(m.index)).map((m) => `the page holds ${m[0]} at offset ${m.index} outside any table darnit read as shown`);
  return { replacements, tables, rows, problems };
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
/** Every model id a replacement cell names, a family without its "*". */
const offered = (text: string) => (isModel(text) ? [text] : (choice(text) ?? [SETTING.exec(text)?.[1] ?? ""].filter(isModel)).map((id) => id.replace(/\*$/, "")));

/**
 * A replacement cell as fix.models holds it: one model id is a rename. Model ids joined by commas or "or", or one
 * model id with a setting, become a reason built from those parts, each model followed by `retiring` first and none
 * of `selves`, the models being replaced, offered. Any other cell gets a fixed reason, never its text.
 */
function entry(record: ChangeRecord, text: string, retiring: (id: string) => string[], selves: ReadonlySet<string>): Replacement {
  const vendor = vendorName(record.vendor);
  const source = record.sources[0]!.url;
  if (isModel(text)) return { model: text, source };
  if (text === EM_DASH) return { human: `${vendor} names no replacement`, source };
  const other = (ids: string[]) => [...new Set(ids.flatMap((id) => retiring(id)))].filter((o) => !selves.has(o.replace(/\*? \(retiring too\)$|\*$/, "")));
  const loop = { human: `the recommended replacements loop back to ${[...selves].at(-1)}`, source };
  const setting = SETTING.exec(text);
  if (setting && isModel(setting[1]!)) {
    const ids = other([setting[1]!]);
    return ids.length > 0 ? { human: `not a plain swap: ${vendor} recommends ${ids.join(" or ")} with ${setting[2]}`, source } : loop;
  }
  const ids = choice(text);
  if (ids) return other(ids).length > 0 ? { human: `not a plain swap: ${vendor} recommends ${either(other(ids))}`, source } : loop;
  return { human: `${vendor} names no single replacement model`, source };
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

const flat = (id: string) => id.replace(/[^a-z0-9]/g, "");

/**
 * fix.models for every record that detects models, keyed by record id, from the newest row naming each model.
 * A replacement the page retires too is followed to one it does not; one that ends with no plain swap, or loops,
 * becomes `human`, and so does one the API spec does not list. A model a reason offers is followed the same way, or
 * said to retire too, and the model being replaced is never offered. A detected model the page has no row for is a
 * problem. So is table markup outside the tables darnit read as shown, every table it cannot read strictly, and every
 * row of a table it read whose folded text holds a detected model darnit did not read from it: an older row must never
 * stand in for a newer one. That check over-reports on purpose; a table or row a person has confirmed names no
 * model goes in `notModels`, by its exact folded text. Model names outside the page's tables are not checked, nor a
 * table or row hidden by a CSS class or a hidden element around it.
 */
export function replacementsFor(
  records: readonly ChangeRecord[],
  page: Page,
  known: ReadonlySet<string>,
  notModels: ReadonlySet<string> = new Set(),
): { models: Map<string, Record<string, Replacement>>; problems: string[] } {
  const newest = (m: string) => page.replacements.get(m)?.[0];
  // Where the page sends a model a reason offers: every model it reaches through the newest rows of retiring ones, in
  // the order met. A retiring model whose row offers no models, or a family such as gpt-4.1*, is marked as retiring
  // too, and so is one whose rows only loop. The answer depends on the model alone, so it is worked out once.
  const sent = new Map<string, string[]>();
  const retiring = (id: string): string[] => {
    if (sent.has(id)) return sent.get(id)!;
    const out = new Set<string>();
    const seen = new Set<string>();
    const todo = [id];
    for (let at = todo.pop(); at !== undefined; at = todo.pop()) {
      const base = at.replace(/\*$/, "");
      const text = newest(base);
      if (text === undefined) out.add(at);
      if (text === undefined || seen.has(at)) continue;
      seen.add(at);
      const next = base === at ? (isModel(text) ? [text] : choice(text)) : undefined;
      if (next) todo.push(...[...next].reverse());
      else out.add(`${at} (retiring too)`);
    }
    sent.set(id, out.size > 0 ? [...out] : [`${id} (retiring too)`]);
    return sent.get(id)!;
  };
  // The replacement for `m`, a rename followed while the page retires it too.
  const resolve = (record: ChangeRecord, m: string): Replacement => {
    const selves = new Set([m]);
    let at = entry(record, newest(m)!, retiring, selves);
    while ("model" in at) {
      const text = newest(at.model);
      if (text === undefined) return at;
      if (selves.has(at.model)) return { human: `the recommended replacements loop back to ${at.model}`, source: at.source };
      selves.add(at.model);
      const after = entry(record, text, retiring, selves);
      if ("human" in after) return { human: `${vendorName(record.vendor)} recommends ${at.model}, which also shuts down; ${after.human}`, source: after.source };
      at = after;
    }
    return at;
  };
  const detected = [...new Set(records.flatMap(recordModels))];
  const real = new Set([...detected, ...known]);
  const onPage = new Set([...page.tables, ...page.rows].map((r) => r.folded));
  const problems = [...notModels].filter((n) => !onPage.has(n)).map((n) => `the known non-model table or row ${n} is no longer on the page; take it off the list`);
  problems.push(...page.problems);
  for (const table of page.tables.filter((t) => t.error !== undefined && !notModels.has(t.folded))) problems.push(`${table.label} (folded: ${table.folded.slice(0, 200)}): ${table.error}`);
  const unread = new Set<string>();
  for (const row of page.rows.filter((r) => !notModels.has(r.folded))) {
    // What darnit read from the row is taken out, longest first, so only names it did not read are left.
    const read = [...row.read, ...(row.exempt && real.has(row.exempt) ? [row.exempt] : [])].map(flat).sort((a, b) => b.length - a.length);
    const rest = read.reduce((text, id) => text.replaceAll(id, " "), row.folded);
    for (const m of detected.filter((d) => rest.includes(flat(d)))) {
      unread.add(m);
      problems.push(`${row.label} (folded: ${row.folded.slice(0, 200)}) may name ${m}, which darnit did not read from it`);
    }
  }
  const models = new Map<string, Record<string, Replacement>>();
  for (const r of records) {
    const ids = recordModels(r);
    const missing = ids.filter((m) => newest(m) === undefined);
    if (missing.length > 0) problems.push(`${r.id}: the page has no row for ${missing.join(", ")}`);
    if (missing.length > 0 || ids.some((m) => unread.has(m)) || ids.length === 0) continue;
    const vendor = vendorName(r.vendor);
    const entries = ids.map((m) => [m, ReplacementSchema.safeParse(listed(resolve(r, m), known, vendor))] as const);
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
