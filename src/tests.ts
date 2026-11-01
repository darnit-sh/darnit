import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readdir } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { escapeHidden, readText } from "./detect.js";
import { childEnv, CREDENTIALS } from "./git.js";

export type TestRun = { command: string; passed: boolean; output: string; timedOut: boolean };

const exists = (path: string) => access(path).then(() => true, () => false);
/** A file that is there, even as a broken link, but that readText turned away. */
const unread = async (path: string, text: string | undefined) => text === undefined && (await lstat(path).then(() => true, () => false));

const NPM_PLACEHOLDER = /no test specified/;

export async function detectTestCommand(root: string, path = process.env.PATH ?? ""): Promise<string | undefined> {
  const pkgPath = join(root, "package.json");
  const pkgText = await readText(pkgPath);
  // One that exists but was skipped may hold the test script; don't guess another runner.
  if (await unread(pkgPath, pkgText)) return undefined;
  if (pkgText !== undefined) {
    try {
      const pkg = JSON.parse(pkgText) as { scripts?: { test?: string } };
      const script = pkg.scripts?.test;
      if (script && !NPM_PLACEHOLDER.test(script)) return `${await packageManager(root)} test`;
    } catch {
      // Not JSON; fall through to Python.
    }
  }
  if (!(await hasPytestSetup(root))) return undefined;
  const python = await pythonOnPath(path);
  return python && `${python} -m pytest -q`;
}

async function packageManager(root: string): Promise<"pnpm" | "yarn" | "npm"> {
  if (await exists(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

/**
 * A command that proves the code still compiles: the repo's typecheck script, else its build
 * script, else its own TypeScript compiler when it has a tsconfig. Undefined when there is none.
 */
export async function detectBuildCommand(root: string): Promise<string | undefined> {
  const pkgText = await readText(join(root, "package.json"));
  if (await unread(join(root, "package.json"), pkgText)) return undefined;
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(pkgText ?? "{}") as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    // Not JSON; no scripts to run.
  }
  for (const name of ["typecheck", "build"]) {
    if (scripts[name]) return `${await packageManager(root)} run ${name}`;
  }
  if ((await exists(join(root, "tsconfig.json"))) && (await exists(join(root, "node_modules", ".bin", "tsc")))) {
    return "node_modules/.bin/tsc --noEmit";
  }
  return undefined;
}

export async function hasPytestSetup(root: string): Promise<boolean> {
  for (const marker of ["pytest.ini", "tox.ini", "conftest.py"]) {
    if (await exists(join(root, marker))) return true;
  }
  // A tests/ folder is common in JavaScript repos too; it only means pytest when it holds Python.
  const tests = await readdir(join(root, "tests"), { recursive: true }).catch(() => []);
  if (tests.some((f) => f.endsWith(".py"))) return true;
  const pyproject = (await readText(join(root, "pyproject.toml"))) ?? "";
  const setupCfg = (await readText(join(root, "setup.cfg"))) ?? "";
  return pyproject.includes("[tool.pytest") || setupCfg.includes("[tool:pytest]");
}

/** The first settings file that is there but could not be read (over 10 MB, not a regular file, or no permission). */
export async function unreadSettings(root: string): Promise<string | undefined> {
  for (const name of ["package.json", "pyproject.toml", "setup.cfg"]) {
    const path = join(root, name);
    if (await unread(path, await readText(path))) return name;
  }
  return undefined;
}

/** python3 first: stock macOS and most Linux distributions have no plain `python`. An active virtualenv provides both. */
async function pythonOnPath(path: string): Promise<string | undefined> {
  for (const name of ["python3", "python"]) {
    for (const dir of path.split(delimiter)) {
      if (dir && (await access(join(dir, name), constants.X_OK).then(() => true, () => false))) return name;
    }
  }
  return undefined;
}

const TAIL_LINES = 40;
// Output can be any size; only the end is kept, small enough for a pull request body (65536 characters).
// A credential cut in two by the limit can't be redacted, so the margin it could sit in is dropped after redaction.
export const TAIL_CHARS = 16 * 1024;
const CUT_MARGIN = 1024;

const base64 = (s: string) => Buffer.from(s).toString("base64").replace(/=+$/, "");

/**
 * `text` with every credential darnit holds replaced by `***`, also in the base64 form a git auth
 * header carries, and the credential on any basic, bearer or token Authorization line replaced too.
 */
function redact(text: string): string {
  return CREDENTIALS.map((k) => process.env[k]?.trim())
    .filter((v): v is string => !!v && v.length >= 8)
    .flatMap((v) => [v, base64(`x-access-token:${v}`), base64(v)])
    .reduce((t, secret) => t.replaceAll(secret, "***"), text)
    .replace(/(authorization:[ \t]*(?:basic|bearer|token)[ \t]+)\S+/gi, "$1***");
}

/** Terminal escape sequences (colors, cursor moves, links), so kept output is plain text. */
// eslint-disable-next-line no-control-regex
const ESCAPES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b\n]*(?:\u0007|\u001b\\)?|[ -/]*[0-~])/g;

/** How long a build or test run may take before it is stopped. */
export const TIME_LIMIT_MINUTES = 10;

export async function runTests(root: string, command: string, timeoutMs = TIME_LIMIT_MINUTES * 60 * 1000): Promise<TestRun> {
  const env: NodeJS.ProcessEnv = { ...(await childEnv()), CI: "1" };
  return new Promise((resolve) => {
    // Detached = its own process group, so a timeout kills the command and not just the shell around it.
    const detached = process.platform !== "win32";
    const child = spawn(command, { cwd: root, shell: true, detached, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let cut = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (detached && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      // A process that left the group can hold the output open; stop reading so "close" comes.
      child.stdout.destroy();
      child.stderr.destroy();
    }, timeoutMs);
    const keep = (d: string) => {
      output += d;
      if (output.length > TAIL_CHARS + CUT_MARGIN) [output, cut] = [output.slice(-(TAIL_CHARS + CUT_MARGIN)), true];
    };
    // One decoder per stream, so a character split across two reads of a pipe is decoded whole.
    child.stdout.setEncoding("utf8").on("data", keep);
    child.stderr.setEncoding("utf8").on("data", keep);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ command, passed: code === 0 && !timedOut, output: kept(output, cut), timedOut });
    });
  });
}

/** Output as darnit keeps it: credentials masked, escape codes out, hidden characters written out, its end only. `cut` when its start was dropped. */
export function kept(output: string, cut = false): string {
  // Masked before and after the codes come out: removing one can cut a token or join one.
  const plain = redact(output).replace(ESCAPES, "");
  const text = cut ? redact(plain).slice(CUT_MARGIN) : redact(plain);
  // Written out before the cut, so escaping can't make what is kept longer than TAIL_CHARS.
  return escapeHidden(text).trimEnd().split("\n").slice(-TAIL_LINES).join("\n").slice(-TAIL_CHARS);
}
