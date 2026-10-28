import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer, type Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  const open: (Server | Socket)[] = [];
  afterEach(() => open.splice(0).forEach((s) => (s instanceof Socket ? s.destroy() : s.close())));

  it("ends an HTTP remote that accepts the connection and never answers, leaving no git process on it", async () => {
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
    const dir = await repoWith({ "a.ts": "a\n" });
    await g.git(dir, ["remote", "add", "origin", `http://127.0.0.1:${(server.address() as AddressInfo).port}/r.git`]);
    await expect(g.git(dir, ["ls-remote", "--heads", "origin", "x"], 1)).rejects.toThrow("git ls-remote timed out after 1 seconds");
    await closed;
  }, 20_000);

  it("stops git after four times the limit on a transport with no stall setting", async () => {
    const dir = await repoWith({ "a.ts": "a\n" });
    await g.git(dir, ["remote", "add", "origin", "ssh://example.invalid/r.git"]);
    const before = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = "sleep 6 #";
    try {
      await expect(g.git(dir, ["push", "-q", "origin", "HEAD:x"], 1)).rejects.toThrow("git push timed out after 4 seconds");
    } finally {
      if (before === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = before;
    }
  }, 20_000);
});
