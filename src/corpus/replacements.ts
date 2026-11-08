import { parse, type DefaultTreeAdapterTypes as T } from "parse5";
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
  // Here and below, a run of spaces is tried only from where it starts, so a long run is read once.
  const listed = allModels(text.split(/(?:(?<!\s)\s+)?[|,]\s*/));
  if (listed) return listed;
  // "GPT-4o (gpt-4o-2024-08-06, gpt-4o-2024-11-20)", "gpt-4-0125-preview (including a and b, which point to this snapshot)".
  // A family name stands for its alias: GPT-4o is gpt-4o, GPT-4o mini is gpt-4o-mini. Anything else, such as "Assistants API (v1)", is no model.
  const open = text.indexOf(" (");
  const name = text.slice(0, open).toLowerCase().replaceAll(" ", "-");
  if (open === -1 || !text.endsWith(")") || !isModel(name) || !/\d/.test(name)) return undefined;
  const inner = text
    .slice(open + 2, -1)
    .replace(/^including /, "")
    .replace(/,? which point to this snapshot$/, "");
  const ids = allModels(inner.split(/,\s*|(?<!\s)\s+and\s+/));
  return ids && [name, ...ids];
}

// The page writes "no replacement" as an em dash; notes darnit writes say it in words.
const EM_DASH = "\u2014";
const NONE = "no replacement named";
// What a cell of a deprecation table may hold besides text, each with the attributes it may carry.
const INLINE: Record<string, readonly string[]> = { code: [], a: ["href"], strong: [], em: [], br: [], sup: [] };
export const MAX_CELL = 10_000;
// A cell holding these is refused: markup characters, controls and bidi controls.
export const UNSAFE = /[<>\p{Cc}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
// A letter, digit or mark outside ASCII, such as a Cyrillic o: a table holding one is not read as a person would.
const NON_ASCII = /(?![\0-\x7f])[\p{L}\p{N}\p{M}]/u;
const REPLACEMENT = new Set(["recommended replacement", "substitute model"]);
// "!important" and the spaces before it, tried only where a run of spaces starts, so a long run is read once.
const IMPORTANT = /(?<!\s)\s*!\s*important$/;

const isElement = (n: T.ChildNode): n is T.Element => "tagName" in n;
const children = (e: T.Element) => e.childNodes.filter(isElement);
const attr = (e: T.Element, name: string) => e.attrs.find((a) => a.name === name)?.value;
/** Whether an inline style hides an element: display none, or visibility hidden or collapse. Any other style shows it. */
const hides = (style: string) =>
  style.split(";").some((declaration) => {
    const at = declaration.indexOf(":");
    const [name, value] = [declaration.slice(0, at), declaration.slice(at + 1)].map((s) =>
      s.trim().toLowerCase().replace(IMPORTANT, ""),
    );
    return (
      at !== -1 &&
      ((name === "display" && value === "none") ||
        (name === "visibility" && (value === "hidden" || value === "collapse")))
    );
  });
/** Whether an element's own attributes hide it. Hiding through a CSS class is not seen. */
const unshown = (e: T.Element) =>
  attr(e, "hidden") !== undefined || hides(attr(e, "style") ?? "") || attr(e, "aria-hidden") === "true";
/**
 * The text a node shows: its text nodes, a <br> as a line break, and a <sup> as a word of its own, as a footnote mark
 * reads, so "o1-mini" with a footnote is not the model "o1-mini2". Comments and template content are not shown.
 */
const text = (n: T.ChildNode): string =>
  n.nodeName === "#text"
    ? (n as T.TextNode).value
    : !isElement(n)
      ? ""
      : n.tagName === "br"
        ? "\n"
        : n.tagName === "sup"
          ? ` ${n.childNodes.map(text).join("")} `
          : n.childNodes.map(text).join("");
/** HTML's whitespace collapsing: ASCII whitespace only, so a no-break space stays a character. */
const collapse = (s: string) => s.replace(/[\t\n\f\r ]+/g, " ").replace(/^ | $/g, "");
/** Whether a cell's elements are all ones a deprecation table may hold, with only the attributes each may carry. */
const plain = (n: T.ChildNode): boolean =>
  !isElement(n) ||
  (Object.hasOwn(INLINE, n.tagName) &&
    n.attrs.every((a) => INLINE[n.tagName]!.includes(a.name)) &&
    n.childNodes.every(plain));

/** The letters and digits a person reads in text, lower case. */
export const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Every table a browser shows on the page, outermost first; a table inside one is part of its text. The parser gives
 * raw-text elements such as script, style, textarea and noscript no elements, and keeps a template's content apart,
 * so tables there are never met; a table an svg shows through foreignObject is.
 */
function shownTables(page: T.Document): T.Element[] {
  const out: T.Element[] = [];
  const todo: T.ParentNode[] = [page];
  for (let node = todo.pop(); node !== undefined; node = todo.pop()) {
    if ("tagName" in node && node.tagName === "table") out.push(node);
    else todo.push(...(node.childNodes.filter((c) => isElement(c) && !unshown(c)).reverse() as T.Element[]));
  }
  return out;
}

/**
 * A table's rows, read strictly: rows only in the table or its thead and tbody, cells only in rows, and no attribute
 * but a class on any of them. Otherwise why darnit does not read the table.
 */
function rowsOf(table: T.Element): { rows: T.Element[]; error?: string } {
  const rows: T.Element[] = [];
  const odd = (e: T.Element, kinds: string[]) => !kinds.includes(e.tagName) || e.attrs.some((a) => a.name !== "class");
  const error = (e: T.Element) => ({
    rows,
    error: `it holds a <${e.tagName}> with ${e.attrs.map((a) => a.name).join(", ") || "no attributes"} where darnit reads only a table, its sections, rows and cells, each with at most a class`,
  });
  if (odd(table, ["table"])) return error(table);
  for (const part of children(table)) {
    if (odd(part, ["thead", "tbody", "tr"])) return error(part);
    for (const tr of part.tagName === "tr" ? [part] : children(part)) {
      if (odd(tr, ["tr"])) return error(tr);
      const cell = children(tr).find((c) => odd(c, ["td", "th"]));
      if (cell) return error(cell);
      rows.push(tr);
    }
  }
  return { rows };
}

/**
 * One row of a table on the page, folded, with the models darnit read from it and, for a fine-tuning row, its model.
 * A model row also has the models of its model cell and its shutdown date, when darnit reads the date.
 */
export type Row = {
  label: string;
  folded: string;
  read: string[];
  exempt?: string;
  models?: string[];
  shutdown?: string;
};

const MONTHS = "january february march april may june july august september october november december".split(" ");
/** A shutdown date cell as YYYY-MM-DD: "Dec 11, 2026", "December 11, 2026" or "2026-12-11". Undefined for anything else. */
export function shutdownDate(cell: string): string | undefined {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cell.replaceAll("\u2011", "-"));
  const named = /^([A-Za-z]{3,9})\.? (\d{1,2}), (\d{4})$/.exec(cell);
  const month = named ? MONTHS.findIndex((m) => m.startsWith(named[1]!.toLowerCase())) + 1 : 0;
  const [y, m, d] = iso
    ? [iso[1], iso[2], iso[3]].map(Number)
    : named && month > 0
      ? [Number(named[3]), month, Number(named[2])]
      : [];
  if (y === undefined || m === undefined || d === undefined) return undefined;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    ? date.toISOString().slice(0, 10)
    : undefined;
}

/** A table of the page, folded, and why darnit does not read it as a person would, if it does not. */
export type Table = { label: string; folded: string; error?: string };

/** What the page's tables say: each model's replacement cells in page order, newest first, every table, and every row of the tables darnit read. */
export type Page = { replacements: Map<string, string[]>; tables: Table[]; rows: Row[] };

/**
 * The tables a browser shows on OpenAI's deprecations page, from the tree the WHATWG HTML parser (parse5) builds. A
 * deprecation table has the shutdown date first, then the model, any price columns, and the replacement column; its
 * cells may hold only text, code, strong, em, br, sup and a link, every row as many cells as its header.
 */
export function readPage(html: string): Page {
  const replacements = new Map<string, string[]>();
  const [tables, rows]: [Table[], Row[]] = [[], []];
  for (const table of shownTables(parse(html))) {
    const label = `table ${tables.length + 1}`;
    const { rows: trs, error: structure } = rowsOf(table);
    const cells = trs.map(children);
    const texts = cells.map((row) => row.map((c) => collapse(text(c))));
    const [head = []] = texts;
    const to =
      head[0]?.toLowerCase() === "shutdown date" ? head.findIndex((h) => REPLACEMENT.has(h.toLowerCase())) : -1;
    const strict =
      to < 2
        ? undefined
        : cells.find((row) => row.length !== head.length)
          ? "a row has a different number of cells from its header"
          : undefined;
    const markup =
      to >= 2 && cells.some((row) => row.some((c) => !c.childNodes.every(plain)))
        ? "a cell holds markup darnit does not read in a deprecation table"
        : undefined;
    const error =
      structure ??
      strict ??
      markup ??
      (NON_ASCII.test(text(table)) ? "it holds a letter, digit or mark outside ASCII" : undefined);
    tables.push({ label, folded: fold(text(table)), ...(error ? { error } : {}) });
    if (error) continue;
    for (const [i, row] of texts.entries()) {
      let read: string[] = [];
      let exempt: string | undefined;
      let models: string[] | undefined;
      if (i > 0 && to >= 2 && row.every((c) => c.length <= MAX_CELL && !UNSAFE.test(c))) {
        models = cellModels(row[1]!);
        for (const m of models ?? []) replacements.set(m, [...(replacements.get(m) ?? []), row[to]!]);
        // A row retiring fine-tuning on a model, not calls to it: exempt when that is a real model.
        exempt = models ? undefined : /^New fine-tuning training on ([a-z0-9._:-]+)$/.exec(row[1]!)?.[1];
        if (models || exempt) read = [...(models ?? []), ...offered(row[to]!)];
      }
      const shutdown = models && shutdownDate(row[0]!);
      rows.push({
        label: `${label} row ${i + 1}`,
        folded: fold(text(trs[i]!)),
        read,
        ...(exempt ? { exempt } : {}),
        ...(models ? { models } : {}),
        ...(shutdown ? { shutdown } : {}),
      });
    }
  }
  return { replacements, tables, rows };
}

// One model id and one setting such as "(reasoning.mode: pro)"; any other words get the fixed reason.
const SETTING = /^(\S+) \(([a-z_.]{1,40}: [a-z0-9_.-]{1,40})\)$/;
const isListed = (s: string) => isModel(s) || (s.endsWith("*") && isModel(s.slice(0, -1)));
const either = (ids: string[]) =>
  ids.length < 3 ? ids.join(" or ") : `${ids.slice(0, -1).join(", ")}, or ${ids.at(-1)}`;
/** The model ids a replacement cell offers as a choice, "a or b" or "a, b, or c", or undefined for any other cell. */
const choice = (text: string) => {
  const ids = text.split(/,? or |, /);
  return ids.length > 1 && ids.every(isListed) ? ids : undefined;
};
/** Every model id a replacement cell names, a family without its "*". */
const offered = (text: string) =>
  isModel(text)
    ? [text]
    : (choice(text) ?? [SETTING.exec(text)?.[1] ?? ""].filter(isModel)).map((id) => id.replace(/\*$/, ""));

/**
 * A replacement cell as fix.models holds it: one model id is a rename. Model ids joined by commas or "or", or one
 * model id with a setting, become a reason built from those parts, each model followed by `retiring` first and none
 * of `selves`, the models being replaced, offered. Any other cell gets a fixed reason, never its text.
 */
function entry(
  record: ChangeRecord,
  text: string,
  retiring: (id: string) => string[],
  selves: ReadonlySet<string>,
): Replacement {
  const vendor = vendorName(record.vendor);
  const source = record.sources[0]!.url;
  if (isModel(text)) return { model: text, source };
  if (text === EM_DASH) return { human: `${vendor} names no replacement`, source };
  const other = (ids: string[]) =>
    [...new Set(ids.flatMap((id) => retiring(id)))].filter(
      (o) => !selves.has(o.replace(/\*? \(retiring too\)$|\*$/, "")),
    );
  const loop = { human: `the recommended replacements loop back to ${[...selves].at(-1)}`, source };
  const setting = SETTING.exec(text);
  if (setting && isModel(setting[1]!)) {
    const ids = other([setting[1]!]);
    return ids.length > 0
      ? { human: `not a plain swap: ${vendor} recommends ${ids.join(" or ")} with ${setting[2]}`, source }
      : loop;
  }
  const ids = choice(text);
  if (ids)
    return other(ids).length > 0
      ? { human: `not a plain swap: ${vendor} recommends ${either(other(ids))}`, source }
      : loop;
  return { human: `${vendor} names no single replacement model`, source };
}

/**
 * A rename only to a model the API lists in `known`, read from the vendor's API spec. A family name the spec lists
 * only as its "-latest" alias, such as omni-moderation, becomes that alias; any other model is for a person.
 */
function listed(r: Replacement, known: ReadonlySet<string>, vendor: string): Replacement {
  if (!("model" in r) || known.has(r.model)) return r;
  if (known.has(`${r.model}-latest`)) return { ...r, model: `${r.model}-latest` };
  return {
    human: `not a plain swap: ${vendor} recommends ${r.model}, which its API spec does not list`,
    source: r.source,
  };
}

const flat = (id: string) => id.replace(/[^a-z0-9]/g, "");

/**
 * Every table a browser shows that darnit cannot read strictly, and every row of a table it read whose folded text
 * holds a model a record detects that darnit did not read from it: an older row must never stand in for a newer one.
 * It over-reports on purpose: a table or row a person has confirmed names no model goes in `notModels`, by its exact
 * folded text, and an entry there matching nothing on the page is a problem. Names outside tables are not checked.
 */
export function pageProblems(
  records: readonly ChangeRecord[],
  page: Page,
  known: ReadonlySet<string>,
  notModels: ReadonlySet<string>,
): { problems: string[]; unread: Set<string> } {
  const detected = [...new Set(records.flatMap(recordModels))];
  const real = new Set([...detected, ...known]);
  const onPage = new Set([...page.tables, ...page.rows].map((r) => r.folded));
  const problems = [...notModels]
    .filter((n) => !onPage.has(n))
    .map((n) => `the known non-model table or row ${n} is no longer on the page; take it off the list`);
  for (const table of page.tables.filter((t) => t.error !== undefined && !notModels.has(t.folded)))
    problems.push(`${table.label} (folded: ${table.folded.slice(0, 200)}): ${table.error}`);
  const unread = new Set<string>();
  for (const row of page.rows.filter((r) => !notModels.has(r.folded))) {
    // What darnit read from the row is taken out, longest first, so only names it did not read are left.
    const read = [...row.read, ...(row.exempt && real.has(row.exempt) ? [row.exempt] : [])]
      .map(flat)
      .sort((a, b) => b.length - a.length);
    const rest = read.reduce((left, id) => left.replaceAll(id, " "), row.folded);
    for (const m of detected.filter((d) => rest.includes(flat(d)))) {
      unread.add(m);
      problems.push(
        `${row.label} (folded: ${row.folded.slice(0, 200)}) may name ${m}, which darnit did not read from it`,
      );
    }
  }
  return { problems, unread };
}

/**
 * fix.models for every record that detects models, keyed by record id, from the newest row naming each model.
 * A replacement the page retires too is followed to one it does not; one that ends with no plain swap, or loops,
 * becomes `human`, and so does one the API spec does not list. A model a reason offers is followed the same way, or
 * said to retire too, and the model being replaced is never offered. A detected model the page has no row for is a
 * problem, and so is everything pageProblems finds.
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
      if (selves.has(at.model))
        return { human: `the recommended replacements loop back to ${at.model}`, source: at.source };
      selves.add(at.model);
      const after = entry(record, text, retiring, selves);
      if ("human" in after)
        return {
          human: `${vendorName(record.vendor)} recommends ${at.model}, which also shuts down; ${after.human}`,
          source: after.source,
        };
      at = after;
    }
    return at;
  };
  const { problems, unread } = pageProblems(records, page, known, notModels);
  const models = new Map<string, Record<string, Replacement>>();
  for (const r of records) {
    const ids = recordModels(r);
    const missing = ids.filter((m) => newest(m) === undefined);
    if (missing.length > 0) problems.push(`${r.id}: the page has no row for ${missing.join(", ")}`);
    if (missing.length > 0 || ids.some((m) => unread.has(m)) || ids.length === 0) continue;
    const vendor = vendorName(r.vendor);
    const entries = ids.map((m) => [m, ReplacementSchema.safeParse(listed(resolve(r, m), known, vendor))] as const);
    const long = entries.filter(([, e]) => !e.success).map(([m]) => m);
    if (long.length > 0)
      problems.push(`${r.id}: the reason for ${long.join(", ")} is not one line of plain words under 200 characters`);
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
      const cell = page.replacements.get(m)?.[0];
      const newest = cell === EM_DASH ? NONE : cell;
      if (!ids.includes(m)) out.push(`${r.id}: the notes name ${m}, which the record does not detect`);
      else if (newest !== said) out.push(`${r.id}: notes say ${m} to ${said}, the page says ${newest ?? "nothing"}`);
    }
  }
  return out;
}

/**
 * Every model of the page's rows on each of `dates`, for the record of that date that detects any of the row's
 * models: each row's first model, then the rest in page order, then any the record detects that no row names.
 * A row with no such record, or more than one, a model another record detects, and a date no row has are problems.
 * Models of rows on other dates that no record detects are `later`, by shutdown date, for the next batches.
 */
export function wholeRows(
  records: readonly ChangeRecord[],
  page: Page,
  dates: ReadonlySet<string>,
): { models: Map<string, string[]>; problems: string[]; later: Map<string, string[]> } {
  const detected = new Set(records.flatMap(recordModels));
  const [rowsOf, later, problems, met] = [
    new Map<string, string[][]>(),
    new Map<string, string[]>(),
    [] as string[],
    new Set<string>(),
  ];
  for (const { label, models, shutdown = "an unread date" } of page.rows) {
    if (!models) continue;
    if (!dates.has(shutdown)) {
      const missing = models.filter((m) => !detected.has(m) && !later.get(shutdown)?.includes(m));
      if (missing.length > 0) later.set(shutdown, [...(later.get(shutdown) ?? []), ...missing]);
      continue;
    }
    met.add(shutdown);
    const owners = records.filter((r) => r.effectiveAt === shutdown && recordModels(r).some((m) => models.includes(m)));
    if (owners.length === 1) rowsOf.set(owners[0]!.id, [...(rowsOf.get(owners[0]!.id) ?? []), models]);
    else
      problems.push(
        `${label} (${models.join(", ")}): ${owners.length === 0 ? `no record shutting down on ${shutdown} detects any of its models; darnit does not make that record yet` : `${owners.map((r) => r.id).join(" and ")} each detect some of its models`}`,
      );
  }
  problems.push(
    ...[...dates]
      .filter((d) => !met.has(d))
      .map((d) => `no model row on the page shuts down on ${d}; take it off the list`),
  );
  const models = new Map<string, string[]>();
  for (const r of records.filter((r) => rowsOf.has(r.id))) {
    const rows = rowsOf.get(r.id)!;
    const ids = [...new Set([...rows.map((row) => row[0]!), ...rows.flat(), ...recordModels(r)])];
    const elsewhere = ids.filter((m) => detected.has(m) && !recordModels(r).includes(m));
    if (elsewhere.length > 0)
      problems.push(`${r.id}: the page lists ${elsewhere.join(", ")} in its rows, but another record detects them`);
    else models.set(r.id, ids);
  }
  return { models, problems, later };
}

const quoted = (ids: readonly string[], lang: "js" | "py") =>
  ids.flatMap((m) =>
    ['"', "'"].map((q) =>
      lang === "js"
        ? { context: `({ model: ${q}${m}${q} })`, selector: "pair" }
        : { context: `f(model=${q}${m}${q})`, selector: "keyword_argument" },
    ),
  );

/** A model record's detection: each model as the call's model, in both quote styles, in JavaScript and Python. */
export const modelDetection = (ids: readonly string[]) => ({
  astGrepPatterns: { js: quoted(ids, "js"), py: quoted(ids, "py") },
});

/** A model record's title: its first models, the rest counted, and the shutdown date, in at most 100 characters. */
export function modelTitle(ids: readonly string[], date: string): string {
  for (let n = Math.min(ids.length, 6); ; n--) {
    const named =
      n === ids.length
        ? `${n > 1 ? `${ids.slice(0, -1).join(", ")} and ` : ""}${ids.at(-1)}`
        : `${ids.slice(0, n).join(", ")} and ${ids.length - n} more`;
    if (named.length <= 75 || n === 1) return `${named} shut down on ${date}`.slice(0, 100);
  }
}

/** A model record's migration notes, naming each model and the replacement cell of its newest row. */
export function modelNotes(vendor: string, ids: readonly string[], date: string, page: Page): string {
  const cells = ids.map((m) => page.replacements.get(m)?.[0] ?? EM_DASH);
  const offers = cells.every((c) => c === EM_DASH)
    ? `${vendor} names no replacement`
    : `Recommended replacements: ${ids.map((m, i) => `${m} to ${cells[i] === EM_DASH ? NONE : cells[i]}`).join("; ")}`;
  return `${vendor} removes these models from the API on ${date}: ${ids.join(", ")}. Calls that name them fail after that date. ${offers}${END}, so test the switch rather than only renaming.`;
}

const call = (m: string, i: number, lang: "js" | "py") =>
  ['"', "'"].map((q, k) =>
    lang === "js"
      ? `export const ${"ab"[k]}${i} = await openai.chat.completions.create({ model: ${q}${m}${q}, messages });`
      : `${"ab"[k]}${i} = client.chat.completions.create(model=${q}${m}${q}, messages=messages)`,
  );

/** A model record's fixture: every model in both quote styles and a longer near miss, the same before and after. */
export function modelFixtures(ids: readonly string[]): Record<string, string> {
  const near = `${ids[0]}-x`;
  const js = `import OpenAI from "openai";\n\nconst openai = new OpenAI();\n\n${ids.flatMap((m, i) => call(m, i, "js")).join("\n")}\n\n// Near miss: a longer name is a different model.\nexport const near = await openai.chat.completions.create({ model: "${near}", messages });\n`;
  const py = `from openai import OpenAI\n\nclient = OpenAI()\n\n${ids.flatMap((m, i) => call(m, i, "py")).join("\n")}\n\n# Near miss: a longer name is a different model.\nnear = client.chat.completions.create(model="${near}", messages=messages)\n`;
  const note =
    "Report only: there are no rules, so after/ matches before/. Every listed model appears in both quote styles; the near miss at the end must not match.";
  const expected = `${JSON.stringify({ note, matches: { "before/app.js": ids.length * 2, "before/app.py": ids.length * 2 } }, null, 2)}\n`;
  return {
    "fixtures/basic/before/app.js": js,
    "fixtures/basic/before/app.py": py,
    "fixtures/basic/after/app.js": js,
    "fixtures/basic/after/app.py": py,
    "fixtures/basic/expected.json": expected,
  };
}
