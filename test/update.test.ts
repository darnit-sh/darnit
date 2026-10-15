import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { get, updateNotice } from "../src/update.js";

type Fetch = typeof get;
const reply = (body: string | Readable, status = 200) => Promise.resolve({ status, body: typeof body === "string" ? Readable.from([Buffer.from(body)]) : body });
const json = (body: unknown, status = 200) => reply(JSON.stringify(body), status);
const registry = (latest: unknown) => vi.fn<Fetch>(() => json({ latest }));
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
    for (const latest of ["0.3.0\n::error::pwned", "0.3.0\n::set-env name=NODE_OPTIONS::--require=/tmp/x", "0.3.0\r\n", "0.3.0::warning::x", " 0.3.0", "9.9.9 ", "01.0.0", "0.03.0"]) {
      expect(await notice("0.2.4", registry(latest), { GITHUB_ACTIONS: "true" })).toBeUndefined();
    }
  });

  it("stays silent on a non-200, non-JSON, a missing or odd latest, or a failed request", async () => {
    expect(await notice("0.2.4", vi.fn<Fetch>(() => json({ latest: "0.3.0" }, 404)))).toBeUndefined();
    expect(await notice("0.2.4", vi.fn<Fetch>(() => json({ latest: "0.3.0" }, 304)))).toBeUndefined();
    expect(await notice("0.2.4", vi.fn<Fetch>(() => reply(("<html>0.3.0</html>"))))).toBeUndefined();
    expect(await notice("0.2.4", registry(3))).toBeUndefined();
    expect(await notice("0.2.4", vi.fn<Fetch>(() => json(null)))).toBeUndefined();
    expect(await notice("0.2.4", vi.fn<Fetch>(() => Promise.reject(new TypeError("fetch failed"))))).toBeUndefined();
  });

  it("drops the body of a non-200 at once, so an unread answer cannot hold the run open", async () => {
    const body = new Readable({ read() {} });
    expect(await notice("0.2.4", vi.fn<Fetch>(() => reply(body, 404)))).toBeUndefined();
    expect(body.destroyed).toBe(true);
  });

  it("stops reading an oversized body after 4 KB", async () => {
    let sent = 0;
    const big = new Readable({
      read() {
        sent += 1024;
        this.push(sent > 1024 * 1024 ? null : Buffer.alloc(1024, 32));
      },
    });
    expect(await notice("0.2.4", vi.fn<Fetch>(() => reply((big))))).toBeUndefined();
    expect(sent).toBeLessThanOrEqual(8 * 1024);
    // A body padded past 4 KB is refused even when it would parse.
    expect(await notice("0.2.4", vi.fn<Fetch>(() => reply((`${" ".repeat(5000)}{"latest":"0.3.0"}`))))).toBeUndefined();
  });

  it("gives up after 1.5 seconds even when the server never answers", async () => {
    const start = Date.now();
    expect(await notice("0.2.4", vi.fn<Fetch>(() => new Promise(() => {})))).toBeUndefined();
    const stalled = new Readable({ read() {} });
    stalled.push('{"latest":');
    expect(await notice("0.2.4", vi.fn<Fetch>(() => reply((stalled))))).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(2 * 1500 + 500);
  });

  it("starts the 1.5 seconds when the check starts, not when it is awaited", async () => {
    const pending = notice("0.2.4", vi.fn<Fetch>(() => new Promise(() => {})));
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
    // Node's own proxy support cannot abort a stalled proxy, so a run set up for it skips the request.
    expect(await notice("0.2.4", fetch, { NODE_USE_ENV_PROXY: "1" })).toBeUndefined();
    expect(await notice("0.2.4", fetch, { NODE_OPTIONS: "--max-old-space-size=4096 --use-env-proxy" })).toBeUndefined();
    const { execArgv } = process;
    process.execArgv = [...execArgv, "--use-env-proxy"];
    try {
      expect(await notice("0.2.4", fetch)).toBeUndefined();
    } finally {
      process.execArgv = execArgv;
    }
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

describe("darnit check", () => {
  it("ends without touching a proxy set through NODE_USE_ENV_PROXY, which could stall it for minutes", async () => {
    const connections: Socket[] = [];
    const proxy = createServer((s) => {
      connections.push(s);
      s.once("data", () => s.write("HTTP/1.1 200 OK\r\n\r\n"));
    }).listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const dir = await mkdtemp(join(tmpdir(), "darnit-update-"));
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` };
    delete env.DARNIT_NO_UPDATE_CHECK;
    delete env.NO_UPDATE_NOTIFIER;
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    try {
      const run = await new Promise<{ code: number | null; signal: string | null }>((resolve) =>
        execFile(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "check"], { cwd: dir, env, timeout: 10_000 }, (err) =>
          resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, signal: (err as { signal?: string } | null)?.signal ?? null }),
        ),
      );
      expect(run).toEqual({ code: 0, signal: null });
      expect(connections).toHaveLength(0);
    } finally {
      for (const s of connections) s.destroy();
      proxy.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
