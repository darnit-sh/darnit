import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { type AddressInfo, createServer, type Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as g from "../src/git.js";
import { runTests } from "../src/tests.js";

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
    expect(await g.uncommitted(dir, ["*.ts"])).toEqual([]);
    expect(await g.diff(dir, ["*.ts"])).toBe("");
  });

  it("lists changed files with unusual names exactly", async () => {
    const names = ["é.ts", "with space.ts", 'quote".ts'];
    const dir = await repoWith(Object.fromEntries(names.map((n) => [n, "a\n"])));
    for (const n of names) await writeFile(join(dir, n), "b\n");
    expect((await g.modified(dir)).sort()).toEqual([...names].sort());
  });
});

/** The environment git gives a program it runs, as `NAME=value` lines: `env` stands in for the diff tool. */
async function gitChildEnv(git = g.git): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "darnit-env-"));
  tempDirs.push(dir);
  await writeFile(join(dir, "a"), "a\n");
  await writeFile(join(dir, "b"), "b\n");
  return git(dir, ["-c", "diff.external=env; true", "diff", "--no-index", "--ext-diff", "a", "b"]).catch((err: { code?: number; stdout?: string }) => {
    if (err.code === 1 && err.stdout !== undefined) return err.stdout;
    throw err;
  });
}

describe("git works on the folder it was given", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("hands git and the repository's commands none of the variables git keeps local to a repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "darnit-env-"));
    tempDirs.push(dir);
    const names = (await promisify(execFile)("git", ["rev-parse", "--local-env-vars"])).stdout.split("\n").filter(Boolean);
    expect(names).toContain("GIT_DIR");
    for (const name of names) {
      // git sets GIT_PREFIX and GIT_CONFIG_PARAMETERS for its own children, so look for the value.
      vi.stubEnv(name, `darnit-marker-${name}`);
      expect(await gitChildEnv(), name).not.toContain("darnit-marker");
      expect((await runTests(dir, "env | grep -c darnit-marker")).output, name).toBe("0");
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["fails", () => Promise.reject(new Error("git: not found"))],
    ["prints nothing", () => Promise.resolve({ stdout: "", stderr: "" })],
  ])("keeps the same variables out when asking git for its list %s", async (_, answer) => {
    vi.resetModules();
    vi.doMock("node:child_process", async (original) => {
      const real = await original<typeof import("node:child_process")>();
      const run = promisify(real.execFile);
      const execFile = Object.assign(() => {}, {
        [promisify.custom]: (file: string, args: string[], opts: object) => (args.includes("--local-env-vars") ? answer() : run(file, args, opts)),
      });
      return { ...real, execFile };
    });
    try {
      const fresh = await import("../src/git.js");
      for (const name of (await promisify(execFile)("git", ["rev-parse", "--local-env-vars"])).stdout.split("\n").filter(Boolean)) {
        vi.stubEnv(name, `darnit-marker-${name}`);
        expect(await gitChildEnv(fresh.git), name).not.toContain("darnit-marker");
        vi.unstubAllEnvs();
      }
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("still reads the config files GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM, HOME and XDG_CONFIG_HOME point to", async () => {
    const dir = await repoWith({ "a.ts": "a\n" });
    const home = await mkdtemp(join(tmpdir(), "darnit-home-"));
    tempDirs.push(home);
    await mkdir(join(home, "git"));
    const where = { GIT_CONFIG_GLOBAL: "global", GIT_CONFIG_SYSTEM: "system", HOME: ".gitconfig", XDG_CONFIG_HOME: "git/config" };
    for (const [name, file] of Object.entries(where)) {
      await writeFile(join(home, file), `[darnit]\n\tprobe = ${name}\n`);
      vi.stubEnv(name, name.startsWith("GIT_") ? join(home, file) : home);
      expect((await g.git(dir, ["config", "--get", "darnit.probe"])).trim()).toBe(name);
      vi.unstubAllEnvs();
      await rm(join(home, file));
    }
  });

  it("reads the folder it was given when GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, GIT_INDEX_FILE or GIT_OBJECT_DIRECTORY names another repository", async () => {
    const dir = await repoWith({ "a.ts": "a\n" });
    const other = await repoWith({ "b.ts": "b\n" });
    const head = (await g.git(dir, ["rev-parse", "HEAD"])).trim();
    const otherGit = join(other, ".git");
    const hostile: Record<string, string> = {
      GIT_DIR: otherGit,
      GIT_WORK_TREE: other,
      GIT_COMMON_DIR: otherGit,
      GIT_INDEX_FILE: join(otherGit, "index"),
      GIT_OBJECT_DIRECTORY: join(otherGit, "objects"),
    };
    for (const name of Object.keys(hostile)) {
      vi.stubEnv(name, hostile[name]);
      expect(await g.git(dir, ["ls-files"]), name).toBe("a.ts\n");
      expect((await g.git(dir, ["rev-parse", "HEAD"])).trim(), name).toBe(head);
      expect(await g.isClean(dir), name).toBe(true);
      vi.unstubAllEnvs();
    }
  });

  it("isRepo is true only inside a checked-out work tree, not in a bare repository or a .git folder", async () => {
    const dir = await repoWith({ "a.ts": "a\n" });
    const parent = await mkdtemp(join(tmpdir(), "darnit-isrepo-"));
    tempDirs.push(parent);
    await mkdir(join(dir, "sub"));
    await g.git(dir, ["worktree", "add", "-q", "--detach", join(parent, "wt")]);
    // Named like a bare repository, but a work tree.
    const clone = (...args: string[]) => promisify(execFile)("git", ["clone", "-q", ...args], { cwd: parent });
    await clone(dir, "look.git");
    await clone("--bare", dir, "bare.git");
    await mkdir(join(parent, "plain", ".git"), { recursive: true });
    const cases: [string, boolean][] = [
      [dir, true],
      [join(dir, "sub"), true],
      [join(parent, "wt"), true],
      [join(parent, "look.git"), true],
      [join(parent, "bare.git"), false],
      [join(parent, "bare.git", "refs"), false],
      [join(dir, ".git"), false],
      [join(dir, ".git", "objects"), false],
      [join(parent, "plain"), false],
      [join(parent, "plain", ".git"), false],
    ];
    for (const [path, expected] of cases) expect(await g.isRepo(path), path).toBe(expected);
    // GIT_DIR from the environment does not make a bare repository look checked out.
    vi.stubEnv("GIT_DIR", join(dir, ".git"));
    vi.stubEnv("GIT_WORK_TREE", dir);
    try {
      expect(await g.isRepo(join(parent, "bare.git"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
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
    // Named after the command, not git's options before it.
    await expect(g.git(dir, ["-C", dir, "push", "-q", "origin", "HEAD:x"], 1)).rejects.toThrow("git push timed out after 4 seconds");
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

  it("hands the push the token through its environment, for that site only, with or without the header the checkout saved", async () => {
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
    // A new call to origin made without a stall limit would get no token, so git() refuses it, after
    // any of git's global options and under a command-line alias.
    for (const args of [
      ["fetch", "origin"],
      ["-c", "x.y=z", "ls-remote", "origin"],
      ["-C", dir, "fetch", "origin"],
      ["--git-dir", join(dir, ".git"), "fetch", "origin"],
      ["--git-dir=.git", "--no-pager", "fetch", "origin"],
      ["-c", "alias.f=fetch", "f", "origin"],
      ["-c", "Alias.f=!git fetch", "f"],
      ["--config-env", "alias.f=X", "f"],
      ["--config-env=alias.f=X", "f"],
      ["remote", "update"],
      ["remote", "show", "origin"],
      ["remote", "-v", "prune", "origin"],
      ["remote", "set-head", "origin", "-a"],
      ["remote", "add", "-f", "other", url],
    ]) {
      await expect(g.git(dir, args), args.join(" ")).rejects.toThrow("reaches origin, so it needs a stall limit");
    }
    // Local commands, `git remote` ones among them, still run without one.
    for (const args of [["remote", "get-url", "origin"], ["-C", dir, "remote", "-v"], ["remote", "add", "other", url], ["-c", "x.y=z", "status"]]) {
      await g.git(dir, args);
    }
  }, 20_000);

  it("sends the token, and no git config the environment held, when the environment already set GIT_CONFIG_COUNT", async () => {
    vi.stubEnv("GIT_TERMINAL_PROMPT", "0");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_TOKEN", token);
    const dir = await repoWith({ "a.ts": "a\n" });
    const branch = (await g.git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const { url, remote } = await guardedOrigin(dir);
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "url.http://127.0.0.1:9/.insteadOf");
    vi.stubEnv("GIT_CONFIG_VALUE_0", url);
    await g.push(dir, branch, url);
    expect(await g.git(remote, ["rev-parse", branch])).toBe(await g.git(dir, ["rev-parse", "HEAD"]));
  }, 20_000);

  it("takes GH_TOKEN when GITHUB_TOKEN is set but empty or blank, and sends either one trimmed", async () => {
    vi.stubEnv("GIT_TERMINAL_PROMPT", "0");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    const dir = await repoWith({ "a.ts": "a\n" });
    const branch = (await g.git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const { url, remote } = await guardedOrigin(dir);
    for (const [github, gh] of [["", token], [" \n", token], [`${token}\n`, ""], ["", ` ${token}\n`]]) {
      vi.stubEnv("GITHUB_TOKEN", github);
      vi.stubEnv("GH_TOKEN", gh);
      expect(await g.remoteBranchExists(dir, branch, url), JSON.stringify([github, gh])).toBe(false);
    }
    await g.push(dir, branch, url);
    expect(await g.git(remote, ["rev-parse", branch])).toBe(await g.git(dir, ["rev-parse", "HEAD"]));
  }, 20_000);

  it("refuses a token with a space or control character inside before git runs", async () => {
    vi.stubEnv("GIT_TERMINAL_PROMPT", "0");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    const dir = await repoWith({ "a.ts": "a\n" });
    const branch = (await g.git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const { url, remote } = await guardedOrigin(dir);
    for (const [github, gh] of [[`${token}\nX`, ""], ["", `${token} X`], [`${token}\u2028X`, token]]) {
      vi.stubEnv("GITHUB_TOKEN", github);
      vi.stubEnv("GH_TOKEN", gh);
      await expect(g.push(dir, branch, url), JSON.stringify([github, gh])).rejects.toThrow(/^the GitHub token holds a character other than printable ASCII \(a space, control or zero-width character, or a letter outside ASCII\); set it again without one$/);
    }
    expect(await g.git(remote, ["branch", "--list"])).toBe("");
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

describe("uncommitted where git composes file names, as on macOS", () => {
  // macOS git lists every name composed (NFC), whatever form readdir gives; Linux git keeps the form it was given.
  // Composing git's output stands in for macOS git here.
  async function composingGit(): Promise<typeof g> {
    vi.resetModules();
    vi.doMock("node:child_process", async (original) => {
      const real = await original<typeof import("node:child_process")>();
      const exec = promisify(real.execFile);
      const execFile = Object.assign((...args: never[]) => (real.execFile as (...a: never[]) => unknown)(...args), {
        [promisify.custom]: async (file: string, args: string[], opts: object) => {
          const out = await exec(file, args, opts);
          return { ...out, stdout: String(out.stdout).normalize("NFC") };
        },
      });
      return { ...real, execFile };
    });
    return import("../src/git.js");
  }

  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it.each([
    ["decomposed", "e\u0301.js"],
    ["composed", "\u00e9.js"],
  ])("finds a clean file named %s on disk", async (_, name) => {
    const dir = await repoWith({ [name]: "a\n" });
    await g.git(dir, ["config", "core.precomposeunicode", "true"]);
    expect(await (await composingGit()).uncommitted(dir, [name])).toEqual([]);
  });

  it("composes names on macOS when core.precomposeunicode is not set", async () => {
    const dir = await repoWith({ "e\u0301.js": "a\n" });
    await g.git(dir, ["config", "--unset-all", "core.precomposeunicode"]).catch(() => undefined);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      expect(await (await composingGit()).uncommitted(dir, ["e\u0301.js"])).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("compares names exactly when core.precomposeunicode is off", async () => {
    const dir = await repoWith({ "e\u0301.js": "a\n" });
    await g.git(dir, ["config", "core.precomposeunicode", "false"]);
    expect(await (await composingGit()).uncommitted(dir, ["e\u0301.js"])).toEqual([{ file: "e\u0301.js" }]);
  });

  // Two files whose names differ only in form can't both exist on macOS.
  it.skipIf(process.platform === "darwin")("still refuses an untracked file whose name only looks like a tracked one", async () => {
    const dir = await repoWith({ "\u00e9.js": "a\n" });
    await writeFile(join(dir, "e\u0301.js"), "b\n");
    expect(await g.uncommitted(dir, ["\u00e9.js", "e\u0301.js"])).toEqual([{ file: "e\u0301.js" }]);
  });
});

describe("patch", () => {
  const lines = (...l: string[]) => `${l.join("\n")}\n`;
  // Each pair gives a different diff under one of the settings below: the algorithm, the indent heuristic, a wider context.
  const algo = [lines("y", "  w();", "y", "y", "  w();", "y", "  w();", "  z();"), lines("}", "y", "y", "y", "", "  w();", "y", "  w();", "  w();", "  z();")];
  const heur = [lines("  w();", "  z();", "y", "x", "{", "}", "  z();", "", "x"), lines("  w();", "  z();", "y", "x", "  z();", "{", "}", "}", "  z();", "x")];
  const far = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  const pairs: Record<string, string[]> = {
    "algo.js": algo,
    "heur.js": heur,
    "far.js": [lines(...far), lines(...far.map((l, i) => (i === 2 || i === 20 ? `${l}!` : l)))],
    "café.js": [lines("a", "", "b"), lines("A", "", "b")],
    "up.js": [lines("a"), lines("b")],
  };

  it("gives the same bytes whatever diff settings the repository's own code wrote", async () => {
    const dir = await repoWith({ ...Object.fromEntries(Object.entries(pairs).map(([f, [a]]) => [f, a!])), ".gitattributes": "up.js diff=up\n" });
    for (const [f, [, b]] of Object.entries(pairs)) await writeFile(join(dir, f), b!);
    const files = Object.keys(pairs);
    const clean = await g.patch(dir, files);
    await writeFile(join(dir, "order"), "up.js\nfar.js\n");
    const hostile = {
      "core.quotePath": "true", "diff.suppressBlankEmpty": "true", "diff.orderFile": join(dir, "order"), "diff.external": "false",
      "diff.up.textconv": "tr a-z A-Z", "color.diff": "always", "color.ui": "always", "diff.context": "8", "diff.interHunkContext": "20",
      "diff.algorithm": "histogram", "diff.indentHeuristic": "false", "diff.noprefix": "true", "diff.mnemonicPrefix": "true", "core.abbrev": "7",
    };
    for (const [key, value] of Object.entries(hostile)) await g.git(dir, ["config", key, value]);
    expect(await g.patch(dir, files)).toBe(clean);
    expect(clean).toMatch(/^diff --git a\/algo\.js b\/algo\.js\nindex [0-9a-f]{40}\.\./);
    expect(clean).toContain("diff --git a/café.js b/café.js");
  });
});

describe("uncommittedReasons", () => {
  it("names changed files and case-only names in one clause each, with the command's own words", () => {
    const files = ["a.js", "b.js", "c.js", "d.js", "e.js", "f.js"].map((file) => ({ file }));
    expect(g.uncommittedReasons([...files, { file: "x.js", gitName: "X.js" }], "init --force would rewrite")).toEqual([
      "uncommitted changes in files init --force would rewrite: a.js, b.js, c.js, d.js, e.js and 1 more; commit or stash them first so git can undo the rewrite",
      "files init --force would rewrite differ only in case from the names git has: x.js (git has X.js); rename them back or commit the rename first",
    ]);
    expect(g.uncommittedReasons([], "darnit needs to edit")).toEqual([]);
  });
});
