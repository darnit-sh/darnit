import { readFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPage, listLines, PAGE_LIMITS, wholeRowRecords } from "../src/corpus/page-rows.js";
import { readPage } from "../src/corpus/replacements.js";
import { loadRecords } from "../src/records/load.js";
import { recordModels } from "../src/records/schema.js";

const FIXTURE = readFile(new URL("./fixtures/deprecations.html", import.meta.url), "utf8");

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

  it("fails on a redirect rather than reading another address than the one it saves", async () => {
    const url = await serve((_, res) => res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" }).end());
    await expect(fetchPage(url, limits)).rejects.toThrow(`could not fetch ${url}: fetch failed (unexpected redirect)`);
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

  it("stops reading an endless body as soon as it passes the size limit, long before the time limit", async () => {
    const endless = await serve((_, res) => {
      const timer = setInterval(() => res.write("x".repeat(1000)), 5);
      res.on("close", () => clearInterval(timer));
    });
    const start = Date.now();
    await expect(fetchPage(endless, { ...limits, timeoutMs: 10_000, maxBytes: 20_000 })).rejects.toThrow(
      `${endless} sent over 20000 bytes`,
    );
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("fails on an address fetch will not ask, naming why", async () => {
    const url = "http://user:pass@127.0.0.1:1/deprecations";
    await expect(fetchPage(url, limits)).rejects.toThrow(
      `could not fetch ${url}: Request cannot be constructed from a URL that includes credentials`,
    );
  });

  it("fails when nothing answers at the address", async () => {
    const url = await serve(() => undefined);
    servers.pop()!.close();
    await expect(fetchPage(url, limits)).rejects.toThrow(`could not fetch ${url}`);
  });

  it("holds the shipped limits by default: 30 seconds, 10,000 to 5,000,000 bytes", async () => {
    expect(PAGE_LIMITS).toEqual({ timeoutMs: 30_000, minBytes: 10_000, maxBytes: 5_000_000 });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const small = await serve((_, res) => res.end("x".repeat(9_999)));
      await expect(fetchPage(small)).rejects.toThrow(`${small} sent 9999 bytes, under the 10000`);
      expect(timeout).toHaveBeenCalledWith(30_000);
      const large = await serve((_, res) => res.end("x".repeat(5_000_001)));
      await expect(fetchPage(large)).rejects.toThrow(`${large} sent over 5000000 bytes`);
      const size = Buffer.byteLength(await FIXTURE);
      expect(size).toBeGreaterThanOrEqual(PAGE_LIMITS.minBytes);
      expect(size).toBeLessThanOrEqual(PAGE_LIMITS.maxBytes);
    } finally {
      timeout.mockRestore();
    }
  });
});

describe("listLines", () => {
  it("reads a corpus list file as its lines, leaving out blank lines and # comments", () => {
    expect(listLines("# Dates whose rows are detected whole.\n2026-12-11\n\n2027-01-14\n")).toEqual([
      "2026-12-11",
      "2027-01-14",
    ]);
  });
});

describe("wholeRowRecords", () => {
  it("has the record of a listed date detect every model of that date's rows, and leaves the rest as loaded", async () => {
    const records = (await loadRecords()).map((l) => l.record);
    const html = (await FIXTURE).replace(
      "<td><code>gpt-5</code> | <code>gpt-5-2025-08-07</code></td>",
      "<td><code>gpt-5</code> | <code>gpt-5-2025-08-07</code> | <code>zzq-9</code></td>",
    );
    const checked = wholeRowRecords(records, readPage(html), new Set(["2026-12-11"])).records;
    const changed = checked.filter((r, i) => r !== records[i]);
    expect(changed.map((r) => r.effectiveAt)).toEqual(["2026-12-11"]);
    expect(recordModels(changed[0]!)).toContain("zzq-9");
  });
});
