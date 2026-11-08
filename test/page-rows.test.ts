import { readFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchPage, PAGE_LIMITS, pageRowsJson, readPageRows, unreadable } from "../src/corpus/page-rows.js";
import { readPage } from "../src/corpus/replacements.js";
import { loadRecords } from "../src/records/load.js";

const FIXTURE = readFile(new URL("./fixtures/deprecations.html", import.meta.url), "utf8");
const about = { source: "https://developers.openai.com/api/docs/deprecations", fetchedAt: "2026-11-08" };

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close().closeAllConnections();
});

async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/deprecations`;
}

describe("fetchPage", () => {
  const limits = { timeoutMs: 300, minBytes: 100, maxBytes: 1000 };

  it("gives back a page of a plausible size", async () => {
    const url = await serve((_, res) => res.end("x".repeat(500)));
    expect(await fetchPage(url, limits)).toBe("x".repeat(500));
  });

  it("fails on a status other than 200, naming it", async () => {
    const url = await serve((_, res) => res.writeHead(500).end("x".repeat(500)));
    await expect(fetchPage(url, limits)).rejects.toThrow(`${url} answered 500, not 200`);
  });

  it("fails when the page sends nothing, or stops halfway, within the time limit", async () => {
    const silent = await serve(() => undefined);
    await expect(fetchPage(silent, limits)).rejects.toThrow(`${silent} did not answer within 0.3 seconds`);
    const stalled = await serve((_, res) => res.write("x".repeat(500)));
    await expect(fetchPage(stalled, limits)).rejects.toThrow(`${stalled} did not answer within 0.3 seconds`);
  });

  it("fails on a body over the size limit, and on one under it", async () => {
    const huge = await serve((_, res) => res.end("x".repeat(5000)));
    await expect(fetchPage(huge, limits)).rejects.toThrow(`${huge} sent over 1000 bytes`);
    const tiny = await serve((_, res) => res.end("x".repeat(99)));
    await expect(fetchPage(tiny, limits)).rejects.toThrow(`${tiny} sent 99 bytes, under the 100`);
  });

  it("fails when nothing answers at the address", async () => {
    const url = await serve(() => undefined);
    servers.pop()!.close();
    await expect(fetchPage(url, limits)).rejects.toThrow(`could not fetch ${url}`);
  });

  it("takes the repository's copy of the page as plausible by default", async () => {
    const size = Buffer.byteLength(await FIXTURE);
    expect(size).toBeGreaterThanOrEqual(PAGE_LIMITS.minBytes);
    expect(size).toBeLessThanOrEqual(PAGE_LIMITS.maxBytes);
  });
});

describe("the rows file", () => {
  it("gives back the page readPage read: its tables, rows and replacements, in page order", async () => {
    const page = readPage(await FIXTURE);
    const back = readPageRows(pageRowsJson(page, about));
    expect(back.page).toStrictEqual(page);
    expect([...back.page.replacements]).toEqual([...page.replacements]);
    expect(back).toMatchObject(about);
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

  it("shows a changed replacement only in its own row and table", async () => {
    const html = await FIXTURE;
    const changed = html.replace("<td><code>gpt-6-luna</code></td> </tr>", "<td><code>gpt-6-sol</code></td> </tr>");
    const [before, after] = [html, changed].map((h) => pageRowsJson(readPage(h), about).split("\n"));
    expect(after).toHaveLength(before!.length);
    const diff = after!.flatMap((line, i) => (line === before![i] ? [] : [line.trim().split(":")[0]]));
    // The table's folded text, then the row's folded text, the model it reads and its replacement cell.
    expect(diff).toEqual(['"folded"', '"folded"', '"gpt-6-sol"', '"replacement"']);
  });

  it("refuses a file holding what readPage never gives", async () => {
    type File = { tables: { error?: string; rows: Record<string, unknown>[] }[] };
    const json = pageRowsJson(readPage(await FIXTURE), about);
    const row = (f: File) => f.tables[0]!.rows[1]!;
    const bad: [string, (f: File) => void][] = [
      ["markup in a replacement", (f) => (row(f).replacement = "<script>alert(1)</script>")],
      ["a control character in a replacement", (f) => (row(f).replacement = "gpt-6‮")],
      ["a model that is no model id", (f) => (row(f).models = ["GPT 4o; rm -rf /"])],
      ["a model row with no replacement", (f) => delete row(f).replacement],
      ["a replacement on a row with no models", (f) => delete row(f).models],
      ["a key readPage never writes", (f) => (row(f).run = "echo")],
      ["rows under a table darnit did not read", (f) => (f.tables[0]!.error = "it holds a <td> with style")],
    ];
    for (const [why, plant] of bad) {
      const file = JSON.parse(json) as File;
      plant(file);
      expect(() => readPageRows(JSON.stringify(file)), why).toThrow("page rows file");
    }
    expect(() => readPageRows("not json")).toThrow("page rows file");
  });
});

describe("unreadable", () => {
  it("finds nothing on the repository's copy of the page, and fails a page with no model row", async () => {
    const records = (await loadRecords()).map((l) => l.record);
    // No model the API spec lists is needed to read the page's rows; the committed spec changes with every refresh.
    const known = new Set<string>();
    expect(unreadable(readPage(await FIXTURE), records, known, new Set())).toEqual([]);
    expect(unreadable(readPage("<p>Moved</p>"), records, known, new Set())).toEqual([
      "darnit read no model row from the page",
    ]);
  });
});
