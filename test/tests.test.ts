import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectBuildCommand, detectTestCommand, runTests, unreadSettings } from "../src/tests.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function dirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "darnit-tests-"));
  tempDirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    if (name.endsWith("/")) await mkdir(join(dir, name), { recursive: true });
    else await writeFile(join(dir, name), text);
  }
  return dir;
}

/** A PATH made of one directory holding executable stand-ins for `names`. */
async function pathWith(...names: string[]): Promise<string> {
  const bin = await dirWith(Object.fromEntries(names.map((n) => [n, "#!/bin/sh\n"])));
  for (const n of names) await chmod(join(bin, n), 0o755);
  return bin;
}

describe("detectBuildCommand", () => {
  it("prefers a typecheck script, then a build script, with the lockfile's package manager", async () => {
    const both = JSON.stringify({ scripts: { typecheck: "tsc --noEmit", build: "tsc" } });
    expect(await detectBuildCommand(await dirWith({ "package.json": both }))).toBe("npm run typecheck");
    expect(await detectBuildCommand(await dirWith({ "package.json": JSON.stringify({ scripts: { build: "tsc" } }), "pnpm-lock.yaml": "" }))).toBe("pnpm run build");
  });

  it("falls back to the repo's own TypeScript compiler", async () => {
    const dir = await dirWith({ "tsconfig.json": "{}", "node_modules/": "", "node_modules/.bin/": "", "node_modules/.bin/tsc": "" });
    expect(await detectBuildCommand(dir)).toBe("node_modules/.bin/tsc --noEmit");
    expect(await detectBuildCommand(await dirWith({ "tsconfig.json": "{}" }))).toBeUndefined();
  });

  it("finds nothing in a plain project", async () => {
    expect(await detectBuildCommand(await dirWith({ "package.json": JSON.stringify({ scripts: { test: "x" } }) }))).toBeUndefined();
    expect(await detectBuildCommand(await dirWith({}))).toBeUndefined();
  });
});

describe("detectTestCommand", () => {
  it("picks the package manager from the lockfile", async () => {
    const pkg = JSON.stringify({ scripts: { test: "vitest" } });
    expect(await detectTestCommand(await dirWith({ "package.json": pkg }))).toBe("npm test");
    expect(await detectTestCommand(await dirWith({ "package.json": pkg, "pnpm-lock.yaml": "" }))).toBe("pnpm test");
    expect(await detectTestCommand(await dirWith({ "package.json": pkg, "yarn.lock": "" }))).toBe("yarn test");
  });

  it("ignores npm's placeholder test script", async () => {
    const pkg = JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } });
    expect(await detectTestCommand(await dirWith({ "package.json": pkg }))).toBeUndefined();
  });

  it("recognises pytest setups", async () => {
    const path = await pathWith("python3");
    expect(await detectTestCommand(await dirWith({ "pytest.ini": "" }), path)).toBe("python3 -m pytest -q");
    expect(await detectTestCommand(await dirWith({ "tests/": "", "tests/test_app.py": "" }), path)).toBe("python3 -m pytest -q");
    expect(await detectTestCommand(await dirWith({ "pyproject.toml": "[tool.pytest.ini_options]\n" }), path)).toBe("python3 -m pytest -q");
    expect(await detectTestCommand(await dirWith({ "setup.cfg": "[tool:pytest]\n" }), path)).toBe("python3 -m pytest -q");
  });

  it("runs pytest with whichever Python is installed, python3 first", async () => {
    const project = await dirWith({ "pytest.ini": "" });
    expect(await detectTestCommand(project, await pathWith("python"))).toBe("python -m pytest -q");
    expect(await detectTestCommand(project, await pathWith("python", "python3"))).toBe("python3 -m pytest -q");
    expect(await detectTestCommand(project, await pathWith())).toBeUndefined();
  });

  it("does not mistake a JavaScript tests/ folder for pytest", async () => {
    expect(await detectTestCommand(await dirWith({ "tests/": "", "tests/app.test.js": "" }), await pathWith("python3"))).toBeUndefined();
  });

  it("finds nothing in an empty project", async () => {
    expect(await detectTestCommand(await dirWith({}))).toBeUndefined();
  });

  /** A project whose `names` are links to a named pipe, which never ends when read. */
  async function linkedToPipe(...names: string[]): Promise<string> {
    const dir = await dirWith({});
    execFileSync("mkfifo", [join(dir, "pipe")]);
    for (const name of names) await symlink(join(dir, "pipe"), join(dir, name));
    return dir;
  }

  it.skipIf(process.platform === "win32")("does not wait on a package.json that is not a regular file", { timeout: 2000 }, async () => {
    const dir = await linkedToPipe("package.json");
    expect(await detectTestCommand(dir)).toBeUndefined();
    expect(await detectBuildCommand(dir)).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("does not wait on Python settings that are not regular files", { timeout: 2000 }, async () => {
    const path = await pathWith("python3");
    expect(await detectTestCommand(await linkedToPipe("pyproject.toml", "setup.cfg"), path)).toBeUndefined();
    const endless = await dirWith({});
    await symlink("/dev/zero", join(endless, "pyproject.toml"));
    expect(await detectTestCommand(endless, path)).toBeUndefined();
  });

  it("does not guess other commands when package.json is too large to read", async () => {
    const big = JSON.stringify({ scripts: { test: "vitest", build: "tsc" }, pad: "x".repeat(10.1 * 1024 * 1024) });
    const dir = await dirWith({ "package.json": big, "pytest.ini": "", "tsconfig.json": "{}", "node_modules/": "", "node_modules/.bin/": "", "node_modules/.bin/tsc": "" });
    expect(await detectTestCommand(dir, await pathWith("python3"))).toBeUndefined();
    expect(await detectBuildCommand(dir)).toBeUndefined();
    expect(await unreadSettings(dir)).toBe("package.json");
    expect(await unreadSettings(await dirWith({ "package.json": "{}", "pyproject.toml/": "" }))).toBe("pyproject.toml");
    expect(await unreadSettings(await dirWith({ "package.json": "{}" }))).toBeUndefined();
  });

  it("does not guess other commands when package.json is a broken link", async () => {
    const dir = await dirWith({ "pytest.ini": "", "tsconfig.json": "{}", "node_modules/": "", "node_modules/.bin/": "", "node_modules/.bin/tsc": "" });
    await symlink(join(dir, "missing.json"), join(dir, "package.json"));
    expect(await detectTestCommand(dir, await pathWith("python3"))).toBeUndefined();
    expect(await detectBuildCommand(dir)).toBeUndefined();
    expect(await unreadSettings(dir)).toBe("package.json");
  });
});

describe("runTests", () => {
  it("captures the tail of the output and the exit status", async () => {
    const dir = await dirWith({});
    const ok = await runTests(dir, "node -e \"console.log('fine'); process.exit(0)\"");
    expect(ok).toMatchObject({ passed: true, output: "fine", timedOut: false });
    const bad = await runTests(dir, "node -e \"console.error('boom'); process.exit(3)\"");
    expect(bad).toMatchObject({ passed: false, output: "boom" });
  });

  it("keeps a bounded tail of any amount of output", async () => {
    const dir = await dirWith({});
    const run = await runTests(dir, "node -e \"process.stdout.write('x'.repeat(5e6) + '\\nend')\"");
    expect(run.output.length).toBeLessThanOrEqual(16 * 1024);
    expect(run.output.endsWith("\nend")).toBe(true);
  });

  it("redacts a token cut in half by the output limit", async () => {
    const dir = await dirWith({});
    const saved = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "ghp_testtoken1234567890";
    try {
      const run = await runTests(dir, `node -e "process.stdout.write('start\\n' + process.argv[1] + 'y'.repeat(16374))" ghp_testtoken1234567890`);
      expect(run.output).not.toContain("1234567890");
    } finally {
      if (saved === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = saved;
    }
  });

  it("runs the commands on the repository it was given when the environment points git at another one", async () => {
    const [mine, other] = [await dirWith({}), await dirWith({})];
    for (const d of [mine, other]) execFileSync("git", ["init", "-q"], { cwd: d });
    vi.stubEnv("GIT_DIR", join(other, ".git"));
    try {
      // What a husky `prepare` script runs.
      expect(await runTests(mine, "git config core.hooksPath .husky")).toMatchObject({ passed: true });
    } finally {
      vi.unstubAllEnvs();
    }
    const hooksPath = (d: string) => execFileSync("git", ["config", "--default", "", "core.hooksPath"], { cwd: d, encoding: "utf8" }).trim();
    expect(hooksPath(other)).toBe("");
    expect(hooksPath(mine)).toBe(".husky");
  });

  it("never hands darnit's GitHub token to the repository's commands, and never shows it", async () => {
    const dir = await dirWith({ "leak.txt": "ghp_testtoken1234567890" });
    const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
    process.env.GITHUB_TOKEN = "ghp_testtoken1234567890";
    process.env.GH_TOKEN = "gho_othertoken0987654321";
    try {
      const env = await runTests(dir, `node -e "console.log(process.env.GITHUB_TOKEN ?? 'no-token', process.env.GH_TOKEN ?? 'no-token')"`);
      expect(env.output).toBe("no-token no-token");
      // A command that finds the token some other way still cannot get it into the output.
      const file = await runTests(dir, "cat leak.txt");
      expect(file.output).not.toContain("ghp_testtoken1234567890");
      expect(file.output).toContain("***");
      // Nor any auth header's value, such as one git config shows.
      await writeFile(join(dir, "leak.txt"), "http.https://github.com/.extraheader AUTHORIZATION: basic c29tZW9uZTpzZWNyZXQ=");
      expect((await runTests(dir, "cat leak.txt")).output).toBe("http.https://github.com/.extraheader AUTHORIZATION: basic ***");
      // Nor in base64, as a git auth header carries it, with no header around it.
      for (const plain of ["x-access-token:ghp_testtoken1234567890", "ghp_testtoken1234567890"]) {
        await writeFile(join(dir, "leak.txt"), Buffer.from(plain).toString("base64"));
        expect((await runTests(dir, "cat leak.txt")).output).toMatch(/^\*\*\*=*$/);
      }
      // Nor by wrapping it in terminal codes that, once removed, would cut or join it.
      for (const wrapped of ["\u001bghp_testtoken1234567890", "\u001b[ghp_testtoken1234567890", "gh\u001b[0mp_testtoken1234567890"]) {
        await writeFile(join(dir, "leak.txt"), wrapped);
        expect((await runTests(dir, "cat leak.txt")).output).not.toContain("testtoken1234567890");
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("hides a token stored with surrounding whitespace, as darnit sends it trimmed", async () => {
    const header = Buffer.from("x-access-token:ghp_testtoken1234567890").toString("base64");
    const dir = await dirWith({ "leak.txt": `token ghp_testtoken1234567890 end ${header}` });
    const saved = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = " ghp_testtoken1234567890\n";
    try {
      expect((await runTests(dir, "cat leak.txt")).output).toMatch(/^token \*\*\* end \*\*\*=*$/);
    } finally {
      if (saved === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = saved;
    }
  });

  it("hides the credential on a basic, bearer or token Authorization line, and nothing else", async () => {
    const lines = ["Authorization: see the docs", "authorization: basic", "next line", "Authorization: Basic c2VjcmV0 x", "AUTHORIZATION: bearer abc.def", "Proxy-Authorization:\tTOKEN ghx_1"];
    const dir = await dirWith({ "leak.txt": lines.join("\n") });
    expect((await runTests(dir, "cat leak.txt")).output.split("\n")).toEqual([...lines.slice(0, 3), "Authorization: Basic *** x", "AUTHORIZATION: bearer ***", "Proxy-Authorization:\tTOKEN ***"]);
  });

  it("kills a hung command after the timeout", async () => {
    const dir = await dirWith({});
    const run = await runTests(dir, "node -e \"setTimeout(() => {}, 60000)\"", 300);
    expect(run).toMatchObject({ passed: false, timedOut: true });
  });

  it.skipIf(process.platform === "win32")("returns at the timeout even when a process left the group and holds the output open", async () => {
    const dir = await dirWith({});
    const start = Date.now();
    const run = await runTests(dir, "perl -MPOSIX -e 'if (fork() == 0) { POSIX::setsid(); sleep 10; exit } sleep 60'", 500);
    expect(run).toMatchObject({ passed: false, timedOut: true });
    // Waiting on the escaped process would take 10 seconds.
    expect(Date.now() - start).toBeLessThan(5000);
  }, 20_000);
});
