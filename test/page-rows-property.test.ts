import { isDeepStrictEqual } from "node:util";
import { expect, it } from "vitest";
import { pageRowsJson, readPageRows } from "../src/corpus/page-rows.js";
import { readPage } from "../src/corpus/replacements.js";

const SOURCE = "https://developers.openai.com/api/docs/deprecations";
const MAX_CELL = 10_000;
// What a cell may hold, as text: markup characters, the entities a page writes them as, whitespace of every kind,
// controls, and the markup that would end a cell, open a comment or close a data section if left unescaped.
const PARTS = ["&", "<", ">", "&lt;", "&#60;", "&#x3c;", "&amp;", "&gt;", "  \t ", "\r\n", "\n", " ", "\0", "\t"];
const MORE = [" ", "</td>", "<!--", "]]>", "gpt-4o", "Dec 11, 2026", "a"];
const ALL = [...PARTS, ...MORE];
const PAGES = 5_000;

/** A small seeded generator, so a failure names a page that can be built again. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const escaped = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Page `n`: a deprecation table of random cells, every thousandth page with one cell of MAX_CELL characters. */
function page(n: number): string {
  const next = random(n);
  const cell = (long: boolean) => {
    let text = "";
    const length = long ? MAX_CELL : Math.floor(next() * 6);
    while (text.length < length) text += ALL[Math.floor(next() * ALL.length)];
    return long ? text.slice(0, MAX_CELL) : text;
  };
  const rows = Array.from({ length: 1 + Math.floor(next() * 4) }, (_, r) =>
    [0, 1, 2].map((c) => cell(n % 1_000 === 0 && r === 0 && c === 1)),
  );
  const tr = (cells: string[], tag: string) =>
    `<tr>${cells.map((c) => `<${tag}>${escaped(c)}</${tag}>`).join("")}</tr>`;
  return `<table>${tr(["Shutdown date", "Model", "Recommended replacement"], "th")}${rows.map((r) => tr(r, "td")).join("")}</table>`;
}

it(`reads back every saved page as the page darnit read, over ${PAGES} pages of random cells`, () => {
  const differ: number[] = [];
  const cells: string[] = [];
  for (let n = 0; n < PAGES; n++) {
    const read = readPage(page(n));
    cells.push(...read.rows.flatMap((r) => r.cells));
    const back = readPageRows(pageRowsJson(read, { source: SOURCE, fetchedAt: "2026-11-08" }), SOURCE).page;
    if (!isDeepStrictEqual(back, read)) differ.push(n);
  }
  expect(differ).toEqual([]);
  // The pages held every hard case, and cells of the longest length the file takes.
  const hard = ["&", "<", ">", "&lt;", "&#60;", "&#x3c;", "&amp;", "&gt;", "</td>", "<!--", "]]>", "\u2028", "\u00a0"];
  expect(hard.filter((h) => !cells.some((c) => c.includes(h)))).toEqual([]);
  expect(cells.filter((c) => c.length > MAX_CELL * 0.9).length).toBeGreaterThanOrEqual(PAGES / 1_000);
});
