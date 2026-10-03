import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

export type TestRun = { command: string; passed: boolean; output: string; timedOut: boolean };

const exists = (path: string) => access(path).then(() => true, () => false);

const NPM_PLACEHOLDER = /no test specified/;

export async function detectTestCommand(root: string): Promise<string | undefined> {
  const pkgText = await readFile(join(root, "package.json"), "utf8").catch(() => undefined);
  if (pkgText !== undefined) {
    try {
      const pkg = JSON.parse(pkgText) as { scripts?: { test?: string } };
      const script = pkg.scripts?.test;
      if (script && !NPM_PLACEHOLDER.test(script)) {
        if (await exists(join(root, "pnpm-lock.yaml"))) return "pnpm test";
        if (await exists(join(root, "yarn.lock"))) return "yarn test";
        return "npm test";
      }
    } catch {
      // Not JSON; fall through to Python.
    }
  }
  for (const marker of ["pytest.ini", "tox.ini", "conftest.py", "tests"]) {
    if (await exists(join(root, marker))) return "python -m pytest -q";
  }
  const pyproject = await readFile(join(root, "pyproject.toml"), "utf8").catch(() => "");
  const setupCfg = await readFile(join(root, "setup.cfg"), "utf8").catch(() => "");
  if (pyproject.includes("[tool.pytest") || setupCfg.includes("[tool:pytest]")) return "python -m pytest -q";
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
