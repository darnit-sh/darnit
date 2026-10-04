import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

export type TestRun = { command: string; passed: boolean; output: string; timedOut: boolean };

const exists = (path: string) => access(path).then(() => true, () => false);

const NPM_PLACEHOLDER = /no test specified/;

export async function detectTestCommand(root: string, path = process.env.PATH ?? ""): Promise<string | undefined> {
  const pkgText = await readFile(join(root, "package.json"), "utf8").catch(() => undefined);
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
  const pkgText = await readFile(join(root, "package.json"), "utf8").catch(() => undefined);
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
  const pyproject = await readFile(join(root, "pyproject.toml"), "utf8").catch(() => "");
  const setupCfg = await readFile(join(root, "setup.cfg"), "utf8").catch(() => "");
  return pyproject.includes("[tool.pytest") || setupCfg.includes("[tool:pytest]");
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

export function runTests(root: string, command: string, timeoutMs = 10 * 60 * 1000): Promise<TestRun> {
  return new Promise((resolve) => {
    // Detached = its own process group, so a timeout kills the command and not just the shell around it.
    const detached = process.platform !== "win32";
    const child = spawn(command, { cwd: root, shell: true, detached, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (detached && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      const tail = output.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
      resolve({ command, passed: code === 0 && !timedOut, output: tail, timedOut });
    });
  });
}
