import { execFile } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { githubToken } from "../src/github.js";

const exec = promisify(execFile);
const TOKEN = "ghp_fake0123456789abcdefghijklmnopqrstuv";
// Every variable gh or git reads a credential from.
const TOKEN_VARS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_HOST",
  "SSH_AUTH_SOCK",
];
const tempDirs: string[] = [];
afterAll(() => Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true }))));
afterEach(() => vi.unstubAllEnvs());

const onPath = (name: string, skip?: string) =>
  (process.env.PATH ?? "")
    .split(delimiter)
    .filter((d) => d && d !== skip)
    .map((d) => join(d, name))
    .filter((f) => {
      try {
        accessSync(f, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });

describe("the tests run with no credential of whoever runs them", () => {
  it("leaves no token variable, gh login, git config or ssh agent in the environment", () => {
    // Names only, so a failure never prints a credential.
    expect(TOKEN_VARS.filter((k) => k in process.env)).toEqual([]);
    expect(readdirSync(process.env.GH_CONFIG_DIR!)).toEqual([]);
    expect(readFileSync(process.env.GIT_CONFIG_GLOBAL!, "utf8")).toBe("");
    expect(process.env.GIT_CONFIG_NOSYSTEM).toBe("1");
  });

  it("finds no token through githubToken, in the test or in a child it starts", async () => {
    const github = fileURLToPath(new URL("../src/github.ts", import.meta.url));
    const script = `const { githubToken } = await import(${JSON.stringify(github)});
console.log(JSON.stringify({ token: (await githubToken()) !== undefined, vars: Object.keys(process.env).filter((k) => ${JSON.stringify(TOKEN_VARS)}.includes(k)) }));`;
    const { stdout } = await exec(process.execPath, [
      "--import",
      import.meta.resolve("tsx"),
      "--input-type=module",
      "-e",
      script,
    ]);
    expect({ test: (await githubToken()) !== undefined, child: JSON.parse(stdout) as unknown }).toEqual({
      test: false,
      child: { token: false, vars: [] },
    });
  });

  it("never runs the real gh, which reads the system keyring even with an empty config folder", async () => {
    const err = (await exec("gh", ["auth", "token"]).catch((e: unknown) => e)) as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    expect(err).toMatchObject({ code: 1, stdout: "", stderr: "gh: not run in the tests\n" });
    const real = onPath("gh", dirname(onPath("gh")[0]!));
    if (real.length === 0) console.info("gh is not installed here; only the environment was checked");
  });

  it("gives a gh that reads its config folder no login", async () => {
    const tools = await mkdtemp(join(tmpdir(), "darnit-gh-"));
    tempDirs.push(tools);
    // Answers as gh does: a token only when its config folder holds a login.
    await writeFile(
      join(tools, "gh"),
      `#!/bin/sh\n[ -f "\${GH_CONFIG_DIR:-$HOME/.config/gh}/hosts.yml" ] && echo ${TOKEN} || exit 1\n`,
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${tools}${delimiter}${process.env.PATH}`);
    expect(await githubToken()).toBeUndefined();
    const login = join(tools, "config");
    await mkdir(login);
    await writeFile(join(login, "hosts.yml"), "github.com:\n  user: someone\n");
    vi.stubEnv("GH_CONFIG_DIR", login);
    expect(await githubToken()).toBe(TOKEN);
  });

  it("gives git no credential helper from the user's or the system's config", async () => {
    const { stdout } = await exec("git", ["config", "--show-origin", "--list"], { cwd: tmpdir() });
    const files = new Set(
      stdout
        .split("\n")
        .filter((l) => l && !l.startsWith("command line:"))
        .map((l) => l.split("\t")[0]),
    );
    expect([...files]).toEqual([]);
  });
});
