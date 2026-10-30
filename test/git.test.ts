import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { type AddressInfo, createServer, type Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as g from "../src/git.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repoWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "darnit-git-"));
  tempDirs.push(dir);
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  await g.git(dir, ["init", "-q"]);
  await g.git(dir, ["add", "."]);
  await g.git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  return dir;
}

/** git http-backend serving the bare repos under `remote`; `send` writes each answer's body. */
function backend(remote: string, send = (res: ServerResponse, body: Buffer) => void res.end(body)) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, "http://x");
    const cgi = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: remote,
        GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: "t",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method,
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
        ...(req.headers["content-length"] ? { CONTENT_LENGTH: req.headers["content-length"] } : {}),
      },
    });
    res.on("close", () => cgi.kill());
    req.pipe(cgi.stdin);
    const out: Buffer[] = [];
    cgi.stdout.on("data", (d: Buffer) => out.push(d));
    cgi.on("close", () => {
      const all = Buffer.concat(out);
      const end = all.indexOf("\r\n\r\n");
      const headers = Object.fromEntries(all.subarray(0, end).toString().split("\r\n").map((l) => l.split(": ") as [string, string]));
      const { Status: status = "200", ...rest } = headers;
      res.writeHead(parseInt(status), rest);
      send(res, all.subarray(end + 4));
    });
  };
}

describe("git treats the repo as untrusted", () => {
  it("runs no hooks or fsmonitor the repo's code planted, and never hands them the token", async () => {
    const dir = await repoWith({ "a.ts": "a\n" });
    const log = join(dir, "..", `${dir.split("/").pop()}.log`);
    tempDirs.push(log);
    const script = `#!/bin/sh\necho "ran with GITHUB_TOKEN=$GITHUB_TOKEN" >> '${log}'\n`;
    for (const f of [".git/hooks/pre-commit", ".git/fsm.sh"]) {
      await writeFile(join(dir, f), script);
      await chmod(join(dir, f), 0o755);
    }
    await g.git(dir, ["config", "core.fsmonitor", join(dir, ".git/fsm.sh")]);
    const token = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "secret-token";
    try {
      await writeFile(join(dir, "a.ts"), "b\n");
      await g.isClean(dir);
      await g.add(dir, ["a.ts"]);
      await g.commit(dir, "change", "body");
    } finally {
      if (token === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = token;
    }
    expect(await readFile(log, "utf8").catch(() => "")).toBe("");
  });

  it("takes file names literally, never as patterns", async () => {
    const dir = await repoWith({ "a.ts": "a\n", "*.ts": "star\n" });
    await writeFile(join(dir, "a.ts"), "changed\n");
    expect(await g.dirtyAmong(dir, ["*.ts"])).toBe(false);
    expect(await g.diff(dir, ["*.ts"], false)).toBe("");
  });

  it("lists changed files with unusual names exactly", async () => {
    const names = ["é.ts", "with space.ts", 'quote".ts'];
    const dir = await repoWith(Object.fromEntries(names.map((n) => [n, "a\n"])));
    for (const n of names) await writeFile(join(dir, n), "b\n");
    expect((await g.modified(dir)).sort()).toEqual([...names].sort());
  });
});

describe("git calls that reach the remote end when it stalls", () => {
  const open: (Server | Socket | HttpServer)[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    open.splice(0).forEach((s) => (s instanceof Socket ? s.destroy() : s.close()));
  });

  const silentOrigin = async (dir: string) => {
    const server = createServer();
    open.push(server);
    // Resolves only once every process holding the connection is gone.
    const closed = new Promise((resolve) =>
      server.on("connection", (socket) => {
        open.push(socket);
        socket.resume().on("close", resolve);
      }),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/r.git`;
    await g.git(dir, ["remote", "add", "origin", url]);
    return { url, closed };
  };

  it.each([
    ["with no setting of its own", () => {}],
    ["when the repo config turns the stall check off for that URL", async (dir: string, url: string) => {
      await g.git(dir, ["config", `http.${url}.lowSpeedLimit`, "0"]);
      await g.git(dir, ["config", `http.${url}.lowSpeedTime`, "0"]);
    }],
    ["when the environment turns the stall check off", () => {
      vi.stubEnv("GIT_HTTP_LOW_SPEED_LIMIT", "0");
      vi.stubEnv("GIT_HTTP_LOW_SPEED_TIME", "0");
    }],
  ])("ends an HTTP remote that accepts the connection and never answers %s, leaving no git process on it", async (_, setup) => {
    const dir = await repoWith({ "a.ts": "a\n" });
    const { url, closed } = await silentOrigin(dir);
    await setup(dir, url);
    await expect(g.git(dir, ["ls-remote", "--heads", "origin", "x"], 1)).rejects.toThrow("git ls-remote timed out after 1 seconds");
    await closed;
  }, 10_000);

  it("lets a slow but steady HTTP push run past four times the limit", async () => {
    const remote = await mkdtemp(join(tmpdir(), "darnit-remote-"));
    tempDirs.push(remote);
    await g.git(remote, ["init", "-q", "--bare", "r.git"]);
    // git http-backend behind a server that sends each answer a byte at a time over 2.5 seconds.
    const server = createHttpServer(
      backend(remote, (res, body) => {
        let at = 0;
        const timer = setInterval(() => (at < body.length ? res.write(body.subarray(at, ++at)) : (clearInterval(timer), res.end())), 2500 / body.length);
      }),
    );
    open.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const dir = await repoWith({ "a.ts": "a\n" });
    await g.git(dir, ["remote", "add", "origin", `http://127.0.0.1:${(server.address() as AddressInfo).port}/r.git`]);
    const start = Date.now();
    await g.git(dir, ["push", "-q", "origin", "HEAD:refs/heads/x"], 1);
    expect(Date.now() - start).toBeGreaterThan(4000);
    expect(await g.git(join(remote, "r.git"), ["rev-parse", "x"])).toBe(await g.git(dir, ["rev-parse", "HEAD"]));
  }, 20_000);

  it("stops git after four times the limit on a transport with no stall setting", async () => {
    const dir = await repoWith({ "a.ts": "a\n" });
    await g.git(dir, ["remote", "add", "origin", "ssh://example.invalid/r.git"]);
    vi.stubEnv("GIT_SSH_COMMAND", "sleep 6 #");
    await expect(g.git(dir, ["push", "-q", "origin", "HEAD:x"], 1)).rejects.toThrow("git push timed out after 4 seconds");
  }, 20_000);
});

describe("push", () => {
  const token = "ghs_fake_for_test";
  const header = `basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  let server: HttpServer | undefined;
  afterEach(() => {
    vi.unstubAllEnvs();
    server?.close();
  });

  // A remote that takes a push only with exactly one auth header, `accept`, and refuses any other, as
  // GitHub refuses a token without push rights.
  async function guardedOrigin(dir: string, accept = header): Promise<{ url: string; remote: string }> {
    const remote = await mkdtemp(join(tmpdir(), "darnit-remote-"));
    tempDirs.push(remote);
    await g.git(remote, ["init", "-q", "--bare", "r.git"]);
    const serve = backend(remote);
    server = createHttpServer((req, res) => {
      const auth = req.headersDistinct.authorization ?? [];
      if (auth.length === 1 && auth[0] === accept) serve(req, res);
      else if (auth.length === 0) res.writeHead(401, { "WWW-Authenticate": 'Basic realm="r"' }).end();
      else res.writeHead(403).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    await g.git(dir, ["remote", "add", "origin", `${url}r.git`]);
    return { url, remote: join(remote, "r.git") };
  }

  it("hands the token to the push alone, through its environment, with or without the header the checkout saved", async () => {
    vi.stubEnv("GIT_TERMINAL_PROMPT", "0");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    const dir = await repoWith({ "a.ts": "a\n" });
    const branch = (await g.git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const { url, remote } = await guardedOrigin(dir);
    vi.stubEnv("GITHUB_TOKEN", "");
    await expect(g.push(dir, branch, url)).rejects.toThrow();
    vi.stubEnv("GITHUB_TOKEN", token);
    // Sent to that site only: the default, github.com, never reaches this server.
    await expect(g.push(dir, branch)).rejects.toThrow();
    await g.push(dir, branch, url);
    expect(await g.git(remote, ["rev-parse", branch])).toBe(await g.git(dir, ["rev-parse", "HEAD"]));
    expect(await readFile(join(dir, ".git/config"), "utf8")).not.toContain(header);
    await g.git(dir, ["config", `http.${url}.extraheader`, `AUTHORIZATION: ${header}`]);
    await writeFile(join(dir, "a.ts"), "b\n");
    await g.add(dir, ["a.ts"]);
    await g.commit(dir, "b", "b");
    await g.push(dir, branch, url);
    expect(await g.git(remote, ["rev-parse", branch])).toBe(await g.git(dir, ["rev-parse", "HEAD"]));
  }, 20_000);

  it("gives every call to origin the token, and refuses one that skips the shared path", async () => {
    vi.stubEnv("GIT_TERMINAL_PROMPT", "0");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_TOKEN", token);
    const dir = await repoWith({ "a.ts": "a\n" });
    const branch = (await g.git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const { url } = await guardedOrigin(dir);
    // fix --pr asks whether the branch exists before the tests run; a private repository needs auth for it.
    expect(await g.remoteBranchExists(dir, branch, url)).toBe(false);
    await g.push(dir, branch, url);
    expect(await g.remoteBranchExists(dir, branch, url)).toBe(true);
    await g.git(dir, ["-c", "x.y=z", "fetch", "-q", "origin"], 30, url);
    // A new call to origin made without a stall limit would get no token, so git() refuses it.
    await expect(g.git(dir, ["fetch", "origin"])).rejects.toThrow("git fetch reaches origin");
    await expect(g.git(dir, ["-c", "x.y=z", "ls-remote", "origin"])).rejects.toThrow("git ls-remote reaches origin");
  }, 20_000);

  it("takes GH_TOKEN for the push when GITHUB_TOKEN is set but empty", async () => {
    vi.stubEnv("GIT_TERMINAL_PROMPT", "0");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", token);
    const dir = await repoWith({ "a.ts": "a\n" });
    const branch = (await g.git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const { url, remote } = await guardedOrigin(dir);
    await g.push(dir, branch, url);
    expect(await g.git(remote, ["rev-parse", branch])).toBe(await g.git(dir, ["rev-parse", "HEAD"]));
  }, 20_000);

  it("leaves the push to git's own credentials outside GitHub Actions, even with a token exported", async () => {
    vi.stubEnv("GIT_TERMINAL_PROMPT", "0");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("GITHUB_TOKEN", token);
    const dir = await repoWith({ "a.ts": "a\n" });
    const branch = (await g.git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const { url, remote } = await guardedOrigin(dir, `Basic ${Buffer.from("me:own").toString("base64")}`);
    await g.git(dir, ["config", "credential.helper", "!f() { echo username=me; echo password=own; }; f"]);
    await g.push(dir, branch, url);
    expect(await g.git(remote, ["rev-parse", branch])).toBe(await g.git(dir, ["rev-parse", "HEAD"]));
  }, 20_000);
});
