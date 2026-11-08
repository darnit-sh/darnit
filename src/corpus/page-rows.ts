import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { recordModels, type ChangeRecord } from "../records/schema.js";
import {
  MAX_CELL,
  modelDetection,
  ONLY,
  pageMismatches,
  readPage,
  replacementsFor,
  shutdownDate,
  TABLE_ERRORS,
  wholeRows,
  type Page,
} from "./replacements.js";

// The tables darnit reads from a vendor's deprecations page, saved as corpus/<vendor>/page-rows.json so the page is
// fetched once a week by the corpus job and every other run reads a committed file. The file holds each read table's
// cell text, and for a table darnit does not read its folded text and why. Everything else is read again from the
// cells by readPage itself when the file is loaded, so a file can only say what some page could.

/** How long the page may take, and the sizes outside which a body is no deprecations page. */
export const PAGE_LIMITS = { timeoutMs: 30_000, minBytes: 10_000, maxBytes: 5_000_000 };

/** The body of an answer, refused past `maxBytes` before it is all read, and under `minBytes`. */
async function body(res: Response, url: string, { minBytes, maxBytes }: typeof PAGE_LIMITS): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  // A 200 answer to a GET always has a body.
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error(`${url} sent over ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  if (size < minBytes) throw new Error(`${url} sent ${size} bytes, under the ${minBytes} of any real page`);
  return Buffer.concat(chunks).toString("utf8");
}

/** The page's text, or an error naming why not: no answer in time, a status other than 200, or a body too small or large. */
export async function fetchPage(url: string, limits = PAGE_LIMITS): Promise<string> {
  const signal = AbortSignal.timeout(limits.timeoutMs);
  try {
    const res = await fetch(url, { signal, redirect: "error" });
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new Error(`${url} answered ${res.status}, not 200`);
    }
    return await body(res, url, limits);
  } catch (err) {
    if (signal.aborted)
      throw new Error(`${url} did not answer within ${limits.timeoutMs / 1000} seconds`, { cause: err });
    if (!(err instanceof TypeError)) throw err;
    const why = err.cause instanceof Error ? ` (${err.cause.message})` : "";
    throw new Error(`could not fetch ${url}: ${err.message}${why}`, { cause: err });
  }
}

/** Whether darnit adds a whole-row date's models to a record: one detecting models as a model record does, with a date. */
export const oneModelRecord = (r: ChangeRecord): r is ChangeRecord & { effectiveAt: string } =>
  r.effectiveAt !== undefined && JSON.stringify(r.detection) === JSON.stringify(modelDetection(recordModels(r)));

/**
 * The records a page is checked against, by npm run corpus and npm run replacements alike: the record shutting down on
 * each date in `dates` (corpus/<vendor>/whole-rows.txt) detects every model of that date's rows, as --write makes it.
 */
export function wholeRowRecords(records: readonly ChangeRecord[], page: Page, dates: ReadonlySet<string>) {
  const whole = wholeRows(records, page, dates);
  const checked = records.map((r) => {
    const ids = whole.models.get(r.id);
    return ids && oneModelRecord(r) ? { ...r, detection: modelDetection(ids) } : r;
  });
  return { whole, records: checked };
}

/**
 * One item for npm run accounting per shutdown date and model of the page's model rows, keyed "page <date> <model>",
 * with the ids of the vendor's records that detect the model. Every other row of a table, below its first, is an item
 * too, keyed by the date in its first cell and the text of its second, and detected by no record: an endpoint, an API,
 * a dated update, or a row whose models darnit cannot read. So no row of any table goes unaccounted, whatever its
 * table's header says.
 */
export function pageItems(page: Page, records: readonly ChangeRecord[], vendor: string) {
  const detecting = detectedBy(records, vendor);
  const items = new Map<string, string[]>();
  for (const row of page.rows.filter((r) => !r.label.endsWith(" row 1"))) {
    const at = `page ${shutdownDate(row.cells[0] ?? "") ?? "no date read"}`;
    if (!row.models) items.set(`${at} ${row.cells[1] || row.cells.join(" | ")}`, []);
    for (const m of row.models ?? []) items.set(`${at} ${m}`, detecting.get(m) ?? []);
  }
  return [...items].map(([key, ids]) => ({ key, ids }));
}

/** Each model the vendor's records detect, with the ids of those records. */
function detectedBy(records: readonly ChangeRecord[], vendor: string) {
  const detecting = new Map<string, string[]>();
  for (const r of records)
    if (r.vendor === vendor) for (const m of recordModels(r)) detecting.set(m, [...(detecting.get(m) ?? []), r.id]);
  return detecting;
}

/**
 * What npm run replacements --check finds between the records and the page, but for the shape of a record's files:
 * every problem wholeRows, replacementsFor and pageMismatches give, and each record whose fix.models is not what
 * replacementsFor gives it.
 */
export function pageDisagreements(
  records: readonly ChangeRecord[],
  page: Page,
  lists: { known: ReadonlySet<string>; notModels: ReadonlySet<string>; wholeDates: ReadonlySet<string> },
): string[] {
  const { whole, records: checked } = wholeRowRecords(records, page, lists.wholeDates);
  const { models, problems } = replacementsFor(checked, page, lists.known, lists.notModels);
  const fixes = records.filter((r) => models.has(r.id) && !isDeepStrictEqual(r.fix?.models, models.get(r.id)));
  return [
    ...whole.problems,
    ...problems,
    ...pageMismatches(records, page),
    ...fixes.map((r) => `${r.id}: its replacements are not what the page gives`),
  ];
}

const MAX_COLUMNS = 50;
const STRUCTURE = new RegExp(`^it holds a <[^\\s/>]+> with (?:no attributes|[^\\s/>=]+(?:, [^\\s/>=]+)*)${ONLY}$`);
const Unread = z.strictObject({
  error: z
    .string()
    .max(2_000)
    .refine((e) => TABLE_ERRORS.includes(e) || STRUCTURE.test(e), "not a reason readPage gives"),
  folded: z
    .string()
    .max(PAGE_LIMITS.maxBytes)
    .regex(/^[a-z0-9]*$/),
});
const Read = z.strictObject({ cells: z.array(z.unknown()) });
const RowsFile = z.strictObject({ fetchedAt: z.iso.date(), source: z.string(), tables: z.array(z.unknown()) });

/** Refuses a rows file, naming where and why in a message cut short, as the file can hold anything. */
function refuse(at: string, why: string): never {
  throw new Error(`the page rows file is not one darnit writes: ${at}: ${why}`.slice(0, 300));
}

function check<T>(schema: z.ZodType<T>, value: unknown, at: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const [issue] = result.error.issues;
  return refuse([at, ...issue!.path.map(String)].join(" "), issue!.message);
}

function rowCells(row: unknown, at: string): string[] {
  if (!Array.isArray(row) || row.length > MAX_COLUMNS) refuse(at, `not a list of at most ${MAX_COLUMNS} cells`);
  for (const [k, cell] of row.entries()) {
    if (typeof cell !== "string") refuse(`${at} cell ${k + 1}`, "not text");
    if (cell.length > MAX_CELL) refuse(`${at} cell ${k + 1}`, `over ${MAX_CELL} characters`);
  }
  return row as string[];
}

/** What readPage reads from a table holding these cells as plain text, with its label and its rows' labels. */
function reread(page: Page, label: string, cells: string[][]): void {
  const html = cells.map(
    (row) => `<tr>${row.map((c) => `<td>${c.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</td>`).join("")}</tr>`,
  );
  const one = readPage(`<table>${html.join("")}</table>`);
  page.tables.push({ ...one.tables[0]!, label });
  for (const [j, row] of one.rows.entries()) page.rows.push({ ...row, label: `${label} row ${j + 1}` });
  for (const [m, texts] of one.replacements) page.replacements.set(m, [...(page.replacements.get(m) ?? []), ...texts]);
}

/**
 * The page as the rows file holds it: each table in page order, a read table as its rows' cells, so a changed cell is
 * one line of a diff. Keys are sorted, so the same page always gives the same bytes. Throws when the file would be
 * refused on load, as with a cell over the length readPage reads. A file it writes reads back as this page, since
 * loading works everything out again with readPage from the very cell text readPage gave.
 */
export function pageRowsJson(page: Page, about: { source: string; fetchedAt: string }): string {
  const tables = page.tables.map((t) =>
    t.error === undefined ? { cells: [] as string[][] } : { error: t.error, folded: t.folded },
  );
  // Rows come only from the tables darnit read, each labelled with its table's place.
  for (const row of page.rows)
    (tables[Number(/^table (\d+) row/.exec(row.label)![1]) - 1] as { cells: string[][] }).cells.push(row.cells);
  const json = `${JSON.stringify({ fetchedAt: about.fetchedAt, source: about.source, tables }, null, 2)}\n`;
  readPageRows(json, about.source);
  return json;
}

/** The page a rows file from `source` holds, read again from its cells, and when it was fetched. Refuses anything else. */
export function readPageRows(json: string, source: string): { page: Page; fetchedAt: string } {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    refuse("the file", "not JSON");
  }
  const file = check(RowsFile, data, "the file");
  if (file.source !== source) refuse("source", `not ${source}`);
  const page: Page = { replacements: new Map(), tables: [], rows: [] };
  for (const [i, table] of file.tables.entries()) {
    const label = `table ${i + 1}`;
    if (typeof table === "object" && table !== null && "error" in table)
      page.tables.push({ label, ...check(Unread, table, label) });
    else
      reread(
        page,
        label,
        check(Read, table, label).cells.map((row, j) => rowCells(row, `${label} row ${j + 1}`)),
      );
  }
  return { page, fetchedAt: file.fetchedAt };
}

/** The lines of a list file in corpus/<vendor>/, without blank lines and # comments. */
export const listLines = (text: string) => text.split("\n").filter((l) => l !== "" && !l.startsWith("#"));
