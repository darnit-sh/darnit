import { once } from "node:events";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { get, updateNotice } from "../src/update.js";

type Fetch = typeof get;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const registry = (latest: unknown) => vi.fn<Fetch>(() => Promise.resolve(json({ latest })));
const notice = (current: string, get: Fetch, env: NodeJS.ProcessEnv = {}) => updateNotice(current, { env, get });

describe("updateNotice", () => {
  it("names the newer line and the workflow change init would write", async () => {
    expect(await notice("0.2.4", registry("0.3.0"))).toBe(
      "darnit 0.3.0 is out (you have 0.2.4): see darnit.sh/changelog and change darnit@0.2 to darnit@0.3 in .github/workflows/darnit.yml",
    );
    expect(await notice("0.9.1", registry("1.0.0"))).toContain("change darnit@0.9 to darnit@1 in");
    expect(await notice("1.4.2", registry("2.0.0"))).toContain("change darnit@1 to darnit@2 in");
  });

  it("stays silent for a patch, an older release, or a newer minor the pin already takes", async () => {
    expect(await notice("0.2.4", registry("0.2.9"))).toBeUndefined();
    expect(await notice("0.3.0", registry("0.2.9"))).toBeUndefined();
    expect(await notice("1.2.0", registry("1.3.0"))).toBeUndefined();
    expect(await notice("0.10.0", registry("0.9.0"))).toBeUndefined();
  });

  it("ignores prereleases on either side", async () => {
    expect(await notice("0.2.0-rc.1", registry("0.3.0"))).toBeUndefined();
    expect(await notice("0.2.4", registry("0.3.0-rc.1"))).toBeUndefined();
  });

  it("is a GitHub Actions notice when run there", async () => {
    expect(await notice("0.2.4", registry("0.3.0"), { GITHUB_ACTIONS: "true" })).toMatch(/^::notice::darnit 0\.3\.0 is out \(you have 0\.2\.4\)/);
  });

  it("never prints a registry version that could add a line or a workflow command", async () => {
    for (const latest of ["0.3.0\n::error::pwned", "0.3.0\n::set-env name=NODE_OPTIONS::--require=/tmp/x", "0.3.0\r\n", "0.3.0::warning::x", " 0.3.0", "9.9.9 "]) {
      expect(await notice("0.2.4", registry(latest), { GITHUB_ACTIONS: "true" })).toBeUndefined();
    }
  });

  it("stays silent on a non-200, non-JSON, a missing or odd latest, or a failed request", async () => {
    expect(await notice("0.2.4", vi.fn<Fetch>(() => Promise.resolve(json({ latest: "0.3.0" }, 404))))).toBeUndefined();
    expect(await notice("0.2.4", vi.fn<Fetch>(() => Promise.resolve(json({ latest: "0.3.0" }, 304))))).toBeUndefined();
    expect(await notice("0.2.4", vi.fn<Fetch>(() => Promise.resolve(new Response("<html>0.3.0</html>"))))).toBeUndefined();
    expect(await notice("0.2.4", registry(3))).toBeUndefined();
    expect(await notice("0.2.4", vi.fn<Fetch>(() => Promise.resolve(json(null))))).toBeUndefined();
    expect(await notice("0.2.4", vi.fn<Fetch>(() => Promise.reject(new TypeError("fetch failed"))))).toBeUndefined();
  });

  it("stops reading an oversized body after 4 KB", async () => {
    let sent = 0;
    const big = new ReadableStream<Uint8Array>({
      pull(c) {
        sent += 1024;
        if (sent > 1024 * 1024) c.close();
        else c.enqueue(new TextEncoder().encode(" ".repeat(1024)));
      },
    });
    expect(await notice("0.2.4", vi.fn<Fetch>(() => Promise.resolve(new Response(big))))).toBeUndefined();
    expect(sent).toBeLessThanOrEqual(8 * 1024);
    // A body padded past 4 KB is refused even when it would parse.
    expect(await notice("0.2.4", vi.fn<Fetch>(() => Promise.resolve(new Response(`${" ".repeat(5000)}{"latest":"0.3.0"}`))))).toBeUndefined();
  });

  it("gives up after 1.5 seconds even when the server never answers", async () => {
    const start = Date.now();
    expect(await notice("0.2.4", vi.fn<Fetch>(() => new Promise<Response>(() => {})))).toBeUndefined();
    const stalled = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new TextEncoder().encode('{"latest":')) });
    expect(await notice("0.2.4", vi.fn<Fetch>(() => Promise.resolve(new Response(stalled))))).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(2 * 1500 + 500);
  });

  it("starts the 1.5 seconds when the check starts, not when it is awaited", async () => {
    const pending = notice("0.2.4", vi.fn<Fetch>(() => new Promise<Response>(() => {})));
    await new Promise((r) => setTimeout(r, 1600));
    const start = Date.now();
    expect(await pending).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("never makes the request with --json or an off switch", async () => {
    const fetch = registry("0.3.0");
    expect(await updateNotice("0.2.4", { env: {}, get: fetch, json: true })).toBeUndefined();
    expect(await notice("0.2.4", fetch, { DARNIT_NO_UPDATE_CHECK: "1" })).toBeUndefined();
    expect(await notice("0.2.4", fetch, { NO_UPDATE_NOTIFIER: "1" })).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    // An empty value is not a switch.
    expect(await notice("0.2.4", fetch, { DARNIT_NO_UPDATE_CHECK: "" })).toBeDefined();
  });

  it("asks only the npm registry for the dist-tags", async () => {
    const fetch = registry("0.3.0");
    await notice("0.2.4", fetch);
    expect(fetch).toHaveBeenCalledWith("https://registry.npmjs.org/-/package/darnit/dist-tags", expect.any(AbortSignal));
  });
});

describe("get", () => {
  it("closes the connection when the time runs out, so a stalled server cannot keep the run open", async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await once(server, "listening");
    const [socket] = (await Promise.all([
      once(server, "connection"),
      get(`https://127.0.0.1:${(server.address() as AddressInfo).port}/`, AbortSignal.timeout(200)).catch(() => undefined),
    ]))[0] as [Socket];
    const closed = Date.now();
    socket.resume();
    if (!socket.closed) await once(socket, "close");
    server.close();
    expect(Date.now() - closed).toBeLessThan(500);
  });
});
