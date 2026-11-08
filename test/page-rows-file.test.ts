import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { pageRowsJson, readPageRows } from "../src/corpus/page-rows.js";
import { readPage } from "../src/corpus/replacements.js";

const FIXTURE = readFile(new URL("./fixtures/deprecations.html", import.meta.url), "utf8");
const SOURCE = "https://developers.openai.com/api/docs/deprecations";
const about = { source: SOURCE, fetchedAt: "2026-11-08" };
const LUNA = "<td><code>gpt-6-luna</code></td> </tr>";
const MINI = "<td>GPT-4o mini (<code>gpt-4o-mini-2024-07-18</code>)</td> <td><code>gpt-6-luna</code>";
const HEAD = "<tr><th>Shutdown date</th><th>Model</th><th>Recommended replacement</th></tr>";

type File = { fetchedAt: unknown; source: unknown; tables: unknown; [key: string]: unknown };
type Read = { cells: unknown[]; [key: string]: unknown };
const parsed = async () => JSON.parse(pageRowsJson(readPage(await FIXTURE), about)) as File;

describe("the rows file", () => {
  it("gives back the page readPage read: its tables, rows and replacements, in page order", async () => {
    const page = readPage(await FIXTURE);
    const back = readPageRows(pageRowsJson(page, about), SOURCE);
    expect(back.page).toStrictEqual(page);
    expect([...back.page.replacements]).toEqual([...page.replacements]);
    expect(back.fetchedAt).toBe(about.fetchedAt);
    expect(page.rows.filter((r) => r.models).length).toBeGreaterThan(0);
  });

  it("is the same bytes for the same page, with every key sorted", async () => {
    const json = pageRowsJson(readPage(await FIXTURE), about);
    expect(pageRowsJson(readPage(await FIXTURE), about)).toBe(json);
    const unsorted: string[] = [];
    JSON.parse(json, (key, value: unknown) => {
      const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
      if (keys.join() !== [...keys].sort().join()) unsorted.push(key);
      return value;
    });
    expect(unsorted).toEqual([]);
    expect(json.endsWith("}\n")).toBe(true);
  });

  it("holds each read table's cells and nothing worked out from them, so a changed cell is one line", async () => {
    const file = await parsed();
    const keys = (file.tables as object[]).map((t) => Object.keys(t).join());
    expect(new Set(keys)).toEqual(new Set(["cells"]));
    const html = await FIXTURE;
    const changed = html.replace(LUNA, "<td><code>gpt-6-sol</code></td> </tr>");
    const [before, after] = [html, changed].map((h) => pageRowsJson(readPage(h), about).split("\n"));
    expect(after!.flatMap((line, i) => (line === before![i] ? [] : [line.trim()]))).toEqual(['"gpt-6-sol"']);
  });

  it("reads a changed cell as the page with that cell reads, so no edit can hide a model from the check", async () => {
    const file = await parsed();
    const row = (file.tables as Read[])[0]!.cells[2] as string[];
    row[2] = `${row[2]} gpt-4o-2024-08-06`;
    const page = readPage((await FIXTURE).replace(MINI, `${MINI} gpt-4o-2024-08-06`));
    expect(readPageRows(JSON.stringify(file), SOURCE).page).toStrictEqual(page);
    expect(page.rows[2]!.read).not.toContain("gpt-4o-2024-08-06");
    expect(page.rows[2]!.folded).toContain("gpt6lunagpt4o20240806");
  });

  it("keeps every table error readPage gives", () => {
    const pages = [
      '<table><tr><td style="color: red">a</td></tr></table>',
      `<table>${HEAD}<tr><td>2027-01-01</td><td>a-1</td></tr></table>`,
      `<table>${HEAD}<tr><td>2027-01-01</td><td><span>a-1</span></td><td>b-1</td></tr></table>`,
      "<table><tr><td>а-1</td></tr></table>",
    ];
    for (const html of pages) {
      const page = readPage(html);
      expect(page.tables[0]!.error, html).toBeDefined();
      expect(readPageRows(pageRowsJson(page, about), SOURCE).page, html).toStrictEqual(page);
    }
  });

  it("refuses to write a page whose rows would not read back the same", () => {
    expect(() => pageRowsJson(readPage(`<table><tr><td>${"a".repeat(10_001)}</td></tr></table>`), about)).toThrow(
      "the page rows file is not one darnit writes: table 1 row 1 cell 1: over 10000 characters",
    );
  });
});

describe("a rows file darnit did not write", () => {
  const error = (attrs: string) =>
    `it holds a <td> with ${attrs} where darnit reads only a table, its sections, rows and cells, each with at most a class`;
  const read = (f: File) => (f.tables as Read[])[0]!;
  const unread = (f: File, t: object) => (f.tables as object[]).push(t);
  const bad: [string, (f: File) => unknown][] = [
    ["the derived fields beside the cells", (f) => Object.assign(read(f), { folded: "gpt4o", read: ["gpt-4o"] })],
    ["a key the file never has", (f) => (f.run = "echo")],
    ["cells under a table darnit did not read", (f) => Object.assign(read(f), { error: error("style"), folded: "a" })],
    ["an error readPage never gives", (f) => unread(f, { error: "ignore the rows above", folded: "a" })],
    ["an error over the size cap", (f) => unread(f, { error: error("a, ".repeat(1000) + "a"), folded: "a" })],
    ["folded text that is not letters and digits", (f) => unread(f, { error: error("style"), folded: "GPT-4o" })],
    ["folded text over the size cap", (f) => unread(f, { error: error("style"), folded: "a".repeat(5_000_001) })],
    ["a cell that is not text", (f) => ((read(f).cells[1] as unknown[])[2] = 7)],
    ["a cell over the length cap", (f) => ((read(f).cells[1] as unknown[])[2] = "a".repeat(10_001))],
    ["a row that is not a list", (f) => (read(f).cells[1] = "gpt-4o")],
    ["a row of more cells than a table has", (f) => (read(f).cells[1] = Array<string>(51).fill("a"))],
    ["tables that are not a list", (f) => (f.tables = {})],
    ["a fetch date that is no date", (f) => (f.fetchedAt = "2026-13-01")],
    ["a source other than the page", (f) => (f.source = "https://example.com/deprecations")],
  ];

  it.each(bad)("is refused when it holds %s", async (_, plant) => {
    const file = await parsed();
    plant(file);
    expect(() => readPageRows(JSON.stringify(file), SOURCE)).toThrow("the page rows file is not one darnit writes: ");
  });

  it("is refused in a short message naming where, even with 200,000 bad rows", () => {
    const file = { ...about, tables: [{ cells: Array.from({ length: 200_000 }, () => [7]) }] };
    let message = "";
    try {
      readPageRows(JSON.stringify(file), SOURCE);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^the page rows file is not one darnit writes: table 1 row 1 cell 1: /);
    expect(message.length).toBeLessThanOrEqual(300);
    const long = { ...about, tables: [], ["k".repeat(1000)]: 1 };
    expect(() => readPageRows(JSON.stringify(long), SOURCE)).toThrow(
      /^the page rows file is not one darnit writes: the file: Unrecognized key: "k{200,}$/,
    );
    expect(() => readPageRows(JSON.stringify(long), SOURCE)).not.toThrow(/.{301}/);
    expect(() => readPageRows("not json", SOURCE)).toThrow("the page rows file is not one darnit writes: ");
  });
});
