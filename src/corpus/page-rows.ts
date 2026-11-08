import { z } from "zod";
import { ModelId, type ChangeRecord } from "../records/schema.js";
import { MAX_CELL, pageProblems, UNSAFE, type Page } from "./replacements.js";

// The rows readPage reads from a vendor's deprecations page, saved as corpus/<vendor>/page-rows.json so the page is
// read once a week by the corpus job and every other run reads a committed file. The file holds only what readPage
// gives, checked as strictly as readPage checks the page: text, never markup, and models only as model ids.

/** How long the page may take, and the sizes outside which a body is no deprecations page. */
export const PAGE_LIMITS = { timeoutMs: 30_000, minBytes: 10_000, maxBytes: 5_000_000 };

/** The body of an answer, refused past `maxBytes` before it is all read, and under `minBytes`. */
async function body(res: Response, url: string, { minBytes, maxBytes }: typeof PAGE_LIMITS): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of (res.body ?? []) as AsyncIterable<Uint8Array>) {
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
    const res = await fetch(url, { signal });
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

/**
 * Why a fetched page is not saved: every table or row darnit cannot read, as npm run replacements finds them, or no
 * model row at all, as on a page that moved.
 */
export function unreadable(
  page: Page,
  records: readonly ChangeRecord[],
  known: ReadonlySet<string>,
  notModels: ReadonlySet<string>,
): string[] {
  const { problems } = pageProblems(records, page, known, notModels);
  return page.rows.some((r) => r.models) ? problems : [...problems, "darnit read no model row from the page"];
}

const Folded = z.string().regex(/^[a-z0-9]*$/);
const Cell = z
  .string()
  .max(MAX_CELL)
  .refine((s) => !UNSAFE.test(s));
const RowFile = z
  .strictObject({
    exempt: z
      .string()
      .regex(/^[a-z0-9._:-]+$/)
      .exactOptional(),
    folded: Folded,
    models: z.array(ModelId).min(1).exactOptional(),
    read: z.array(ModelId),
    replacement: Cell.exactOptional(),
    shutdown: z.iso.date().exactOptional(),
  })
  .refine((r) => (r.models === undefined) === (r.replacement === undefined));
const PageRowsFile = z.strictObject({
  fetchedAt: z.iso.date(),
  source: z.url(),
  tables: z.array(
    z
      .strictObject({ error: z.string().exactOptional(), folded: Folded, rows: z.array(RowFile) })
      .refine((t) => t.error === undefined || t.rows.length === 0),
  ),
});
type RowFile = z.infer<typeof RowFile>;

const sortKeys = (_: string, v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
    : v;

/**
 * The page as the rows file holds it: each table with its rows in page order, since the first row naming a model is its
 * newest, and each model row with its replacement cell. Labels are left out, as they follow from the order, so a new
 * row shows in a diff as that row alone. Keys are sorted, so the same page always gives the same bytes.
 */
export function pageRowsJson(page: Page, about: { source: string; fetchedAt: string }): string {
  const seen = new Map<string, number>();
  const tables = page.tables.map((t) => ({ ...t, label: undefined, rows: [] as RowFile[] }));
  for (const { label, models, ...row } of page.rows) {
    const table = tables[Number(/^table (\d+) row/.exec(label)![1]) - 1]!;
    const replacement = models && page.replacements.get(models[0]!)![seen.get(models[0]!) ?? 0];
    for (const m of models ?? []) seen.set(m, (seen.get(m) ?? 0) + 1);
    table.rows.push({ ...row, ...(models ? { models, replacement } : {}) });
  }
  return `${JSON.stringify({ ...about, tables }, sortKeys, 2)}\n`;
}

/** The page a rows file holds, as readPage gave it, with where and when it was fetched. Throws on a file readPage could not have given. */
export function readPageRows(json: string): { page: Page; source: string; fetchedAt: string } {
  let parsed;
  try {
    parsed = PageRowsFile.parse(JSON.parse(json));
  } catch (err) {
    throw new Error(`the page rows file is not one darnit writes: ${(err as Error).message}`, { cause: err });
  }
  const page: Page = { replacements: new Map(), tables: [], rows: [] };
  for (const [i, { rows, ...table }] of parsed.tables.entries()) {
    const label = `table ${i + 1}`;
    page.tables.push({ label, ...table });
    for (const [j, { replacement, ...row }] of rows.entries()) {
      for (const m of row.models ?? []) page.replacements.set(m, [...(page.replacements.get(m) ?? []), replacement!]);
      page.rows.push({ label: `${label} row ${j + 1}`, ...row });
    }
  }
  return { page, source: parsed.source, fetchedAt: parsed.fetchedAt };
}

/** The lines of a list file in corpus/<vendor>/, without blank lines and # comments. */
export const listLines = (text: string) => text.split("\n").filter((l) => l !== "" && !l.startsWith("#"));
