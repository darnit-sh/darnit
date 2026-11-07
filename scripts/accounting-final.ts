import { lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { type NotCovered, NotCoveredSchema, openItems, readOptional } from "../src/corpus/accounting.js";
import { forTerminal, prose } from "../src/fix.js";

// What `npm run accounting --final` adds to the plain run: each vendor's open items held to the ceiling committed in
// packs/<vendor>/record-ceiling.txt, and the open list written as Markdown for the release notes.

// Keys are spec text: quoted, and anything outside printable ASCII written as an escape, so a name cannot hide or forge a line.
export const show = (key: string) =>
  JSON.stringify(key).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** The flags, strictly: an unknown or misspelled flag, a value on --final, or --notes without --final throws. */
export function parseFlags(args: string[]): { root?: string | undefined; final: boolean; notes?: string | undefined } {
  const { values } = parseArgs({
    args,
    strict: true,
    options: { root: { type: "string" }, final: { type: "boolean" }, notes: { type: "string" } },
  });
  if (values.notes !== undefined && !values.final) throw new Error("--notes <file> goes with --final");
  return { root: values.root, final: values.final === true, notes: values.notes };
}

export const readNotCovered = async (root: string, vendor: string): Promise<NotCovered> =>
  NotCoveredSchema.parse(parseYaml((await readOptional(join(root, "packs", vendor, "not-covered.yaml"))) ?? "") ?? []);

/** How many items the file marks needs-record; what accounting counts open whenever it passes. */
export const marked = (notCovered: NotCovered) =>
  notCovered.filter((e) => e["needs-record"]).reduce((n, e) => n + e.items.length, 0);

export const ceilingFile = (vendor: string) => `packs/${vendor}/record-ceiling.txt`;

/** The committed ceiling: one whole number, no sign or leading zero. Missing, empty or anything else throws. */
export async function readCeiling(root: string, vendor: string): Promise<number> {
  const text = await readOptional(join(root, ceilingFile(vendor)));
  if (text === undefined) throw new Error(`${ceilingFile(vendor)} is missing`);
  if (!/^(0|[1-9][0-9]*)\r?\n?$/.test(text)) throw new Error(`${ceilingFile(vendor)} does not hold one whole number`);
  const ceiling = Number(text.trim());
  if (!Number.isSafeInteger(ceiling)) throw new Error(`${ceilingFile(vendor)} holds a number too large to count to`);
  return ceiling;
}

/** What the ceiling says of `open` items: false above it, or when it cannot be read or would let any number through. */
async function againstCeiling(root: string, vendor: string, open: number, items: number) {
  const ceiling = await readCeiling(root, vendor).catch((err: Error) => err);
  if (ceiling instanceof Error) return { ok: false, says: ceiling.message };
  const where = `the ceiling of ${ceiling} in ${ceilingFile(vendor)}`;
  if (ceiling > items) return { ok: false, says: `${where} is above all ${items} items accounting reads` };
  if (open > ceiling) return { ok: false, says: `${open} need a record, above ${where}` };
  if (open < ceiling) return { ok: true, says: `${open} need a record, below ${where}; lower it to ${open}` };
  return { ok: true, says: `${open} need a record, at ${where}` };
}

/** One vendor's verdict for a final release: refused when the accounting above failed or the ceiling says so. */
export async function judgeCeiling(input: {
  root: string;
  vendor: string;
  open: number;
  items: number;
  failed: boolean;
}) {
  const ceiling = await againstCeiling(input.root, input.vendor, input.open, input.items);
  const ok = ceiling.ok && !input.failed;
  const why = input.failed ? "the accounting above failed; " : "";
  return { ok, line: `final release ${ok ? "passes" : "refused"}, ${input.vendor}: ${why}${ceiling.says}` };
}

/** The open section, soonest first: each date and proposal as the plain run prints it, then its keys. */
export const openEntries = (needsRecord: Parameters<typeof openItems>[0], today: string) =>
  openItems(needsRecord, today).map((o) => ({
    head: `${o.date ? `${o.date}${o.past ? ", already past" : ""}` : "no date"}: ${o.proposal.replace(/\s+/g, " ").trim()}`,
    keys: o.keys,
  }));

// Text as the terminal shows it, control characters gone and hidden ones written out, then made inert for GitHub.
const markdown = (text: string) => prose(forTerminal(text, false, {}));

/** One vendor's open items as Markdown for the release notes; keys are quoted and escaped as printed first. */
export function notesSection(vendor: string, entries: ReturnType<typeof openEntries>): string[] {
  const count = entries.reduce((n, e) => n + e.keys.length, 0);
  const lines = [`## ${markdown(vendor)}: ${count} open, each needing a record`, ""];
  for (const e of entries) lines.push(`- ${markdown(e.head)}`, ...e.keys.map((k) => `  - ${markdown(show(k))}`));
  return entries.length > 0 ? [...lines, ""] : [lines[0]!, "", "None.", ""];
}

/** Refuses a notes path that exists in any form, a link included, so no earlier file is taken for this run's. */
export async function refuseExisting(file: string): Promise<void> {
  const found = await lstat(file).then(
    () => true,
    (err: NodeJS.ErrnoException) => (err.code === "ENOENT" ? false : Promise.reject(err)),
  );
  if (found) throw new Error(`${file} already exists; the notes go only to a new file`);
}

/** Writes the notes to a new file only: an existing file or link at the path fails the write. */
export const writeNotes = (file: string, lines: string[]) => writeFile(file, lines.join("\n"), { flag: "wx" });
