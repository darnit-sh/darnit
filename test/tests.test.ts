import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectTestCommand, runTests } from "../src/tests.js";

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
});

describe("runTests", () => {
  it("captures the tail of the output and the exit status", async () => {
    const dir = await dirWith({});
    const ok = await runTests(dir, "node -e \"console.log('fine'); process.exit(0)\"");
    expect(ok).toMatchObject({ passed: true, output: "fine", timedOut: false });
    const bad = await runTests(dir, "node -e \"console.error('boom'); process.exit(3)\"");
    expect(bad).toMatchObject({ passed: false, output: "boom" });
  });

  it("kills a hung command after the timeout", async () => {
    const dir = await dirWith({});
    const run = await runTests(dir, "node -e \"setTimeout(() => {}, 60000)\"", 300);
    expect(run).toMatchObject({ passed: false, timedOut: true });
  });
});
