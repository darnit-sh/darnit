import { once } from "node:events";
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Record every child process darnit spawns, then run it for real, so one --publish run can be checked spawn by spawn.
const spawns = vi.hoisted(
  () =>
    [] as {
      file: string;
      args: string[];
      cwd?: string | undefined;
      env?: NodeJS.ProcessEnv | undefined;
      timeout?: number | undefined;
      signal?: AbortSignal | undefined;
    }[],
);
vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  const util = await import("node:util");
  const note = (file: string, args: unknown, opts: unknown) => {
    const o = (opts && typeof opts === "object" ? opts : {}) as {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      timeout?: number;
      signal?: AbortSignal;
    };
    spawns.push({
      file,
      args: Array.isArray(args) ? (args as string[]) : [],
      cwd: o.cwd,
      env: o.env,
      timeout: o.timeout,
      signal: o.signal,
    });
  };
  const execFile = function (file: string, ...rest: unknown[]) {
    note(
      file,
      rest[0],
      rest.find((r) => r && typeof r === "object" && !Array.isArray(r)),
    );
    return (real.execFile as unknown as (...a: unknown[]) => unknown)(file, ...rest);
  } as unknown as typeof real.execFile & { [k: symbol]: unknown };
  const realCustom = (real.execFile as unknown as { [k: symbol]: (...a: unknown[]) => unknown })[util.promisify.custom];
  (execFile as unknown as { [k: symbol]: unknown })[util.promisify.custom] = (
    file: string,
    args: unknown,
    opts: unknown,
  ) => {
    note(file, args, opts);
    return realCustom!(file, args, opts);
  };
  return { ...real, execFile };
});

// Imported after the mock, so darnit's `promisify(execFile)` captures the recording version.
const { fix } = await import("../src/fix.js");
const { git } = await import("../src/git.js");

const PACKS = fileURLToPath(new URL("../packs/", import.meta.url));
const BEFORE = join(PACKS, "openai", "2024-09-12-max-tokens-to-max-completion-tokens", "fixtures", "basic", "before");
const TOKEN = "ghp_fake0123456789abcdefghijklmnopqrstuv";

const tempDirs: string[] = [];
const temp = async (prefix: string, where = tmpdir()) => {
  const dir = await mkdtemp(join(where, prefix));
  tempDirs.push(dir);
  return dir;
};
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  spawns.length = 0;
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
beforeEach(() => {
  for (const k of [
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "SSH_AUTH_SOCK",
    "GITHUB_ACTIONS",
    "GITHUB_SHA",
    "GITHUB_SERVER_URL",
    "GITHUB_REPOSITORY",
  ])
    vi.stubEnv(k, "");
});

it("runs every --publish spawn with the expected arguments and an allowlisted environment", async () => {
  // A repository on a local bare remote that stands in for github.com.
  const dir = await temp("darnit-job1-");
  await cp(BEFORE, dir, { recursive: true });
  await git(dir, ["init", "-q"]);
  await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
  await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  const bare = await temp("darnit-origin-");
  await git(bare, ["init", "-q", "--bare"]);
  await git(bare, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  await git(dir, ["remote", "add", "origin", bare]);
  const branch = (await git(dir, ["symbolic-ref", "--short", "HEAD"])).trim();
  await git(dir, ["push", "-q", "-u", "origin", branch], 60);
  vi.stubEnv("DARNIT_TEST_ORIGIN", bare);

  // The plan the verify job would write.
  const plan = join(await temp("darnit-plan-"), "plan");
  await fix(dir, { prepare: plan, noTest: true, version: "t" });

  // A gh outside any folder the job controls, that returns the token, so `gh auth token` is reached and recorded.
  const tools = join(await temp("darnit-tools-", homedir()), "bin");
  await mkdir(tools);
  await writeFile(join(tools, "gh"), `#!/bin/sh\necho ${TOKEN}\n`);
  await chmod(join(tools, "gh"), 0o755);

  // A local server in GitHub's place; no token in the environment, so it comes from gh.
  const posts: Record<string, string>[] = [];
  const server = (await import("node:http")).createServer((req, res) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString()));
    req.on("end", () => {
      if (req.method === "POST") posts.push(JSON.parse(data) as Record<string, string>);
      const reply =
        req.url === "/repos/o/r"
          ? { default_branch: branch }
          : req.method === "POST"
            ? { html_url: `https://github.com/o/r/pull/${posts.length}` }
            : [];
      res.writeHead(req.method === "POST" ? 201 : 200).end(JSON.stringify(reply));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
    realFetch(String(url).replace("https://api.github.com/", `http://127.0.0.1:${port}/`), init),
  );

  spawns.length = 0;
  // A sensitive variable the job holds: it must reach none of the spawns (the allowlist drops it).
  vi.stubEnv("SSH_ASKPASS", "/evil/askpass");
  vi.stubEnv("PATH", `${tools}:${process.env.PATH}`);
  try {
    const result = await fix(dir, { publish: plan, repo: "o/r", version: "t" });
    expect(result.records.map((r) => r.pr?.state)).toEqual(["opened"]);
  } finally {
    server.close();
  }

  const gitCalls = spawns.filter((s) => /(?:^|\/)git$/.test(s.file));
  const version = gitCalls.filter((s) => s.args[0] === "version");
  const clone = gitCalls.filter((s) => s.args[0] === "-C");
  const SUBS = /^(init|fetch|ls-remote|checkout|add|commit|push|diff)$/;
  const sub = (s: { args: string[] }) => s.args.find((a) => SUBS.test(a));
  const ghCalls = spawns.filter((s) => /(?:^|\/)gh$/.test(s.file));
  const astGrep = spawns.filter((s) => /ast-grep/.test(s.file) || s.args[0] === "scan");

  // The version check and every clone command ran a resolved absolute git, outside the work tree, with no credential.
  expect(version).toHaveLength(1);
  expect(new Set(clone.map(sub))).toEqual(
    new Set(["init", "ls-remote", "fetch", "checkout", "diff", "add", "commit", "push"]),
  );
  for (const s of [...version, ...clone]) {
    expect(s.file.startsWith("/")).toBe(true);
    expect(s.env).toBeDefined();
    expect(s.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(s.env).not.toHaveProperty("GH_TOKEN");
    expect(s.env).not.toHaveProperty("SSH_ASKPASS");
  }
  // Each clone command carries darnit's hardening: no system config, no replace objects, no hooks, an empty global and HOME.
  for (const s of clone) {
    expect(s.cwd).not.toBe(dir);
    expect(s.args).toContain("core.hooksPath=/dev/null");
    expect(s.env!.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(s.env!.GIT_NO_REPLACE_OBJECTS).toBe("1");
    // HOME, XDG and the global config point into darnit's throwaway clone folder, which it makes empty, not the machine's.
    expect(s.env!.HOME).toMatch(/darnit-publish-[^/]+\/home$/);
    expect(s.env!.XDG_CONFIG_HOME).toBe(s.env!.HOME);
    expect(s.env!.GIT_CONFIG_GLOBAL).toMatch(/darnit-publish-[^/]+\/global\.config$/);
  }
  // gh ran from a neutral folder, with the folders it reads its login from but no credential or other inherited variable.
  expect(ghCalls).toHaveLength(1);
  expect(ghCalls[0]!.args).toEqual(["auth", "token"]);
  expect(ghCalls[0]!.cwd).toBe(tmpdir());
  expect(ghCalls[0]!.env).not.toHaveProperty("GITHUB_TOKEN");
  expect(ghCalls[0]!.env).not.toHaveProperty("SSH_ASKPASS");
  // gh is given the folders it reads its own login from.
  expect(ghCalls[0]!.env!.HOME).toBe(process.env.HOME);
  // ast-grep ran with the same allowlist; no credential reaches it.
  expect(astGrep.length).toBeGreaterThan(0);
  for (const s of astGrep) {
    expect(s.env).toBeDefined();
    expect(s.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(s.env).not.toHaveProperty("SSH_ASKPASS");
  }
});

const HTTP = "http://127.0.0.1:1/r.git";
const HTTPS = "https://127.0.0.1:1/r.git";
const SSH = "ssh://example.invalid/r.git";
const stall = 2;
const killAfter = stall * 4 * 1000;

const PUSH = ["push", "-q", "origin", "HEAD:x"];

// Nothing listens on port 1 and the ssh command exits, so every call fails at once and no test waits on a clock.
// The last spawn is the call itself: the ones before it read the remote's URLs.
const failedCall = async (dir: string, args: string[], limit = stall, more?: { env: NodeJS.ProcessEnv }) => {
  vi.stubEnv("GIT_SSH_COMMAND", "false");
  await expect(git(dir, args, limit, undefined, more)).rejects.toThrow();
  const call = spawns.at(-1)!;
  expect(call.args).toEqual(expect.arrayContaining(args));
  expect(call.signal).toBeUndefined();
  return call;
};
const repoWithOrigin = async (urls: string[], pushUrls = urls) => {
  const dir = await temp("darnit-limits-");
  await git(dir, ["init", "-q"]);
  await git(dir, ["remote", "add", "origin", urls[0]!]);
  for (const url of urls.slice(1)) await git(dir, ["remote", "set-url", "--add", "origin", url]);
  for (const url of pushUrls) await git(dir, ["remote", "set-url", "--add", "--push", "origin", url]);
  return dir;
};

describe("the process timeout on a call to origin", () => {
  it.each<[string, string[], number]>([
    ["http", [HTTP], 0],
    ["https", [HTTPS], 0],
    ["a scheme in capitals", ["HTTPS://127.0.0.1:1/r.git"], 0],
    ["two HTTP URLs", [HTTP, HTTPS], 0],
    ["ssh", [SSH], killAfter],
    ["http and then ssh", [HTTP, SSH], killAfter],
    ["ssh and then http", [SSH, HTTP], killAfter],
    ["scp form", ["git@example.invalid:r.git"], killAfter],
    ["a scheme that starts like http", ["httpsx://127.0.0.1:1/r.git"], killAfter],
    ["http only inside an ssh URL", [`ssh://example.invalid/${HTTP}`], killAfter],
  ])("sets the process timeout for a push to %s", async (_, urls, timeout) => {
    expect((await failedCall(await repoWithOrigin(urls), PUSH)).timeout).toBe(timeout);
  });

  it("judges a push by its push URL, past git's own options, and any other call by the fetch URL", async () => {
    const dir = await repoWithOrigin([HTTP], [SSH]);
    expect((await failedCall(dir, ["-c", "x.y=z", ...PUSH])).timeout).toBe(killAfter);
    expect((await failedCall(dir, ["fetch", "-q", "origin"])).timeout).toBe(0);
    expect((await failedCall(dir, ["ls-remote", "origin"])).timeout).toBe(0);
  });

  it.each([
    ["ssh", [SSH]],
    ["http and then ssh", [HTTP, SSH]],
    ["ssh and then http", [SSH, HTTP]],
  ])("sets the process timeout for a fetch or ls-remote from %s, whatever the push URL", async (_, urls) => {
    const dir = await repoWithOrigin(urls, [HTTP]);
    expect((await failedCall(dir, PUSH)).timeout).toBe(0);
    for (const args of [
      ["fetch", "-q", "origin"],
      ["ls-remote", "origin"],
    ]) {
      expect((await failedCall(dir, args)).timeout).toBe(killAfter);
      expect((await failedCall(dir, args, stall, { env: {} })).timeout).toBe(killAfter);
    }
  });

  it("keeps the process timeout on a push that passes its own environment", async () => {
    const call = await failedCall(await repoWithOrigin([SSH]), PUSH, stall, { env: {} });
    expect(call.timeout).toBe(killAfter);
  });
});

describe("the limit given to a call to origin", () => {
  it("gives git its own stall limit, whatever the transport", async () => {
    for (const url of [HTTP, SSH]) {
      const call = await failedCall(await repoWithOrigin([url]), PUSH);
      expect(call.env).toMatchObject({ GIT_HTTP_LOW_SPEED_LIMIT: "1", GIT_HTTP_LOW_SPEED_TIME: String(stall) });
    }
  });

  it("sets both limits from the value passed", async () => {
    const call = await failedCall(await repoWithOrigin([SSH]), PUSH, 3);
    expect(call.timeout).toBe(12_000);
    expect(call.env).toMatchObject({ GIT_HTTP_LOW_SPEED_TIME: "3" });
  });
});
