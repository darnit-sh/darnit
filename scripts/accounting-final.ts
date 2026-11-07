import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { type NotCovered, NotCoveredSchema, openItems, readOptional } from "../src/corpus/accounting.js";

// What `npm run accounting --final` adds to the plain run: each vendor's open items held to the ceiling committed in
// packs/<vendor>/record-ceiling.txt, and the open list written as Markdown for the release notes.

const escapes = (s: string, chars: RegExp) =>
  s.replace(chars, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

// Keys are spec text: quoted, and anything outside printable ASCII written as an escape, so a name cannot hide or forge a line.
export const show = (key: string) => escapes(JSON.stringify(key), /[^\x20-\x7e]/g);

// Control, format and line separator characters escaped, then every ASCII punctuation mark, so text reads as itself.
const markdown = (s: string) => escapes(s, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu).replace(/[!-/:-@[-`{-~]/g, (c) => `\\${c}`);

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

/** Whether a final release may go out with `open` items: a line naming both numbers, and false above the ceiling. */
export async function judgeCeiling(input: { root: string; vendor: string; open: number; items: number }) {
  const { vendor, open, items } = input;
  const ceiling = await readCeiling(input.root, vendor).catch((err: Error) => err);
  if (ceiling instanceof Error) return { ok: false, line: `${vendor}: ${ceiling.message}` };
  const where = `the ceiling of ${ceiling} in ${ceilingFile(vendor)}`;
  // A ceiling above every item accounting reads would let any number through.
  if (ceiling > items) return { ok: false, line: `${vendor}: ${where} is above all ${items} items accounting reads` };
  if (open > ceiling) return { ok: false, line: `${vendor}: ${open} need a record, above ${where}` };
  if (open < ceiling)
    return { ok: true, line: `${vendor}: ${open} need a record, below ${where}; lower it to ${open}` };
  return { ok: true, line: `${vendor}: ${open} need a record, at ${where}` };
}

/** The open section, soonest first: each date and proposal as the plain run prints it, then its keys. */
export const openEntries = (needsRecord: Parameters<typeof openItems>[0], today: string) =>
  openItems(needsRecord, today).map((o) => ({
    head: `${o.date ? `${o.date}${o.past ? ", already past" : ""}` : "no date"}: ${o.proposal.replace(/\s+/g, " ").trim()}`,
    keys: o.keys,
  }));

/** One vendor's open items as Markdown for the release notes, every piece of spec or file text escaped. */
export function notesSection(vendor: string, entries: ReturnType<typeof openEntries>): string[] {
  const count = entries.reduce((n, e) => n + e.keys.length, 0);
  const lines = [`## ${markdown(vendor)}: ${count} open, each needing a record`, ""];
  for (const e of entries) lines.push(`- ${markdown(e.head)}`, ...e.keys.map((k) => `  - ${markdown(show(k))}`));
  return entries.length > 0 ? [...lines, ""] : [lines[0]!, "", "None.", ""];
}
