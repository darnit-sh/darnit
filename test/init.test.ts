import { execFile, execFileSync } from "node:child_process";
import type { Stats } from "node:fs";
import { appendFile, chmod, cp, type FileHandle, link, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { detectApis, MAX_FILE_BYTES, readText } from "../src/detect.js";
import { git } from "../src/git.js";
import { init, pinned } from "../src/init.js";
import { cpuTime, matchersAtDarnit, SETUP_NODE_MATCHERS } from "./helpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return { ...real, stat: vi.fn(real.stat), lstat: vi.fn(real.lstat) };
});

const SAMPLES = fileURLToPath(new URL("./samples/", import.meta.url));

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function scratchCopy(sample: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "darnit-init-"));
  tempDirs.push(dir);
  await cp(join(SAMPLES, sample), dir, { recursive: true });
  return dir;
}

const commitAll = async (dir: string) => {
  await git(dir, ["add", "-A"]);
  await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x"]);
};

/** A sample repo with `files` written and everything committed. */
async function committed(sample: string, files: Record<string, string> = {}): Promise<string> {
  const dir = await scratchCopy(sample);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  await git(dir, ["init", "-q"]);
  await commitAll(dir);
  return dir;
}

describe("detectApis", () => {
  it("finds openai in every sample repo, by the right evidence", async () => {
    const small = await detectApis(join(SAMPLES, "small"));
    expect(small).toEqual([{ vendor: "openai", evidence: ["index.js: import openai", "package.json: openai"] }]);

    const medium = await detectApis(join(SAMPLES, "medium"));
    expect(medium.map((d) => d.vendor)).toEqual(["openai", "stripe"]);
    expect(medium[0]?.evidence).toEqual([
      "package.json: openai",
      "requirements.txt: openai",
      "src/chat.ts: import openai",
      "worker.py: import openai",
    ]);

    // messy: no SDK anywhere, only a raw fetch to the API host
    const messy = await detectApis(join(SAMPLES, "messy"));
    expect(messy.find((d) => d.vendor === "openai")?.evidence).toEqual(["lib/client.js: api.openai.com"]);
    expect(messy.find((d) => d.vendor === "stripe")?.evidence).toEqual(["pyproject.toml: stripe"]);
  });

  it("ignores node_modules and other vendored directories, and survives bad manifests", async () => {
    const dir = await scratchCopy("small");
    await mkdir(join(dir, "node_modules", "some-lib"), { recursive: true });
    await writeFile(
      join(dir, "node_modules", "some-lib", "package.json"),
      JSON.stringify({ dependencies: { "@anthropic-ai/sdk": "1.0.0", stripe: "1.0.0" } }),
    );
    await mkdir(join(dir, "templates"));
    await writeFile(join(dir, "templates", "package.json"), '﻿{ "name": "{{name}}", // not json\n');
    expect((await detectApis(dir)).map((d) => d.vendor)).toEqual(["openai"]);
  });

  it("counts a Python package only when a manifest declares it, not when prose mentions it", async () => {
    const dir = await scratchCopy("small");
    await writeFile(join(dir, "Pipfile"), '[packages]\nstripe = "*"\n');
    await writeFile(join(dir, "pyproject.toml"), '[project]\ndescription = "an anthropic wrapper"\n# openai not used\n');
    expect(await detectApis(dir)).toEqual([
      { vendor: "openai", evidence: ["index.js: import openai", "package.json: openai"] },
      { vendor: "stripe", evidence: ["Pipfile: stripe"] },
    ]);
  });
});

describe("detectApis on a repository built to slow it down", () => {
  it("finishes quickly on a Python file of blank lines", async () => {
    const dir = await scratchCopy("small");
    await writeFile(join(dir, "blank.py"), "\n".repeat(150_000));
    const time = await cpuTime(async () => expect((await detectApis(dir)).map((d) => d.vendor)).toEqual(["openai"]), 3, 2000);
    expect(time).toBeLessThan(2000);
  });

  it("does not read a file over the size limit, and init says so", async () => {
    const dir = await mkdtemp(join(tmpdir(), "darnit-init-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "big.py"), `import stripe\n${" ".repeat(MAX_FILE_BYTES)}`);
    const tooLarge: string[] = [];
    expect(await detectApis(dir, tooLarge)).toEqual([]);
    expect(tooLarge).toEqual(["big.py"]);
    expect((await init(dir)).slice(0, 2)).toEqual([
      "Scanned repo: no known APIs found (the scheduled check still runs)",
      "Not checked: 1 file over 10 MB: big.py.",
    ]);
  });

  it("names the folders it did not enter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "darnit-init-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "src/vendor"), { recursive: true });
    await writeFile(join(dir, "src/vendor/client.py"), "import openai\n");
    expect((await init(dir)).slice(0, 2)).toEqual([
      "Scanned repo: no known APIs found (the scheduled check still runs)",
      "Not checked: 1 dependency or build folder: src/vendor.",
    ]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("names a source file it could not read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "darnit-init-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "client.py"), "import openai\n");
    await chmod(join(dir, "client.py"), 0o000);
    expect((await init(dir)).slice(0, 2)).toEqual([
      "Scanned repo: no known APIs found (the scheduled check still runs)",
      "Not checked: could not read client.py.",
    ]);
  });

  it.skipIf(process.platform === "win32")("keeps a crafted file name in its evidence on one line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "darnit-init-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "x\n::error::\u202Ey.py"), "import openai\n");
    const [summary] = await init(dir);
    expect(summary).toBe("Scanned repo: found openai (x?::error::\\u202ey.py: import openai)");
  });

  it.skipIf(process.platform === "win32")("prints folder names without their control characters, and no check mark on Not checked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "darnit-init-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "a\u001b[2J\u001b[31mPWNED", "vendor"), { recursive: true });
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "init"], { cwd: dir, env: { ...process.env, GITHUB_ACTIONS: "" } });
    expect(stdout).not.toContain("\u001b");
    expect(stdout).toContain("\nNot checked: 1 dependency or build folder: a?[2J?[31mPWNED/vendor.\n");
    expect(stdout).toMatch(/^✓ Scanned repo: /);
  });

  it("reads only regular files", async () => {
    expect(await readText("/dev/zero")).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("does not wait on a named pipe", { timeout: 2000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "darnit-init-"));
    tempDirs.push(dir);
    execFileSync("mkfifo", [join(dir, "darnit.yml")]);
    expect(await readText(join(dir, "darnit.yml"))).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("does not wait on a named pipe swapped in after the first check", { timeout: 2000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "darnit-init-"));
    tempDirs.push(dir);
    execFileSync("mkfifo", [join(dir, "darnit.yml")]);
    vi.mocked(stat).mockResolvedValueOnce({ isFile: () => true, size: 0 } as Stats);
    expect(await readText(join(dir, "darnit.yml"))).toBeUndefined();
  });

  it("reads no more than the size limit from a file that grew after the check", async () => {
    const dir = await mkdtemp(join(tmpdir(), "darnit-init-"));
    tempDirs.push(dir);
    const path = join(dir, "notes.txt");
    await writeFile(path, "x".repeat(MAX_FILE_BYTES + 1));
    const handle = await open(path);
    const grew = vi.spyOn(Object.getPrototypeOf(handle) as FileHandle, "stat").mockResolvedValueOnce({ isFile: () => true, size: 0 } as Stats);
    await handle.close();
    const starts: string[] = [];
    expect(await readText(path, (start) => starts.push(start))).toBeUndefined();
    expect(starts).toEqual(["x".repeat(8192)]);
    grew.mockRestore();
  });
});

describe("init", () => {
  it("writes darnit.yml and the workflow, and is a no-op on the second run", async () => {
    const dir = await scratchCopy("medium");

    const first = await init(dir);
    expect(first[0]).toMatch(/^Scanned repo: found openai \(package\.json: openai\), stripe \([^)]*; recognized only\)/);
    expect(first.slice(1)).toEqual(["Wrote darnit.yml", "Wrote .github/workflows/darnit.yml"]);

    const yml = await readFile(join(dir, "darnit.yml"), "utf8");
    expect(yml).toContain("openai:\n    tier: supported");
    expect(yml).toContain("stripe:\n    tier: recognized");
    const workflow = await readFile(join(dir, ".github", "workflows", "darnit.yml"), "utf8");
    expect(workflow).toContain("cron:");
    const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(workflow).toContain(`- run: cd "\${RUNNER_TEMP:?}" && npx darnit@${pinned(version)} check "\${GITHUB_WORKSPACE:?}"\n`);

    const second = await init(dir);
    expect(second.slice(1)).toEqual([
      "darnit.yml exists, left unchanged (--force to rewrite)",
      ".github/workflows/darnit.yml exists, left unchanged (--force to rewrite)",
    ]);
    expect(await readFile(join(dir, "darnit.yml"), "utf8")).toBe(yml);

    const forced = await init(dir, { force: true });
    expect(forced.slice(1)).toEqual(["darnit.yml is up to date, left unchanged", ".github/workflows/darnit.yml is up to date, left unchanged"]);
  });

  it("writes a workflow that removes every problem matcher setup-node registers before darnit runs", async () => {
    const dir = await scratchCopy("medium");
    await init(dir);
    const workflow = parse(await readFile(join(dir, ".github", "workflows", "darnit.yml"), "utf8")) as { jobs: Record<string, { steps: { uses?: string; run?: string }[] }> };
    expect(Object.keys(workflow.jobs)).toEqual(["check"]);
    const { steps } = workflow.jobs.check!;
    expect(matchersAtDarnit(steps)).toEqual([]);
    // What the runner reads from the step, which is what removes them.
    const removal = steps.filter((s) => s.run?.includes("::remove-matcher"));
    expect(removal).toHaveLength(1);
    const printed = execFileSync("bash", ["-e", "-c", removal[0]!.run!], { encoding: "utf8" });
    expect(printed).toBe(Object.keys(SETUP_NODE_MATCHERS).map((owner) => `::remove-matcher owner=${owner}::\n`).join(""));
  });

  it.skipIf(process.platform === "win32")("keeps a rewritten file's permissions", async () => {
    const dir = await committed("small", { "darnit.yml": "old\n" });
    await chmod(join(dir, "darnit.yml"), 0o600);
    await init(dir, { force: true });
    expect((await stat(join(dir, "darnit.yml"))).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("drops setuid and setgid from a rewritten file", async () => {
    const dir = await committed("small", { "darnit.yml": "old\n" });
    await chmod(join(dir, "darnit.yml"), 0o4755);
    await commitAll(dir);
    await init(dir, { force: true });
    expect((await stat(join(dir, "darnit.yml"))).mode & 0o7777).toBe(0o755);
  });

  it("says Wrote, not Rewrote, under --force when nothing was there", async () => {
    const dir = await scratchCopy("small");
    expect((await init(dir, { force: true })).slice(1)).toEqual(["Wrote darnit.yml", "Wrote .github/workflows/darnit.yml"]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("changes no file when a write fails", async () => {
    const dir = await committed("small", { "darnit.yml": "old\n" });
    await mkdir(join(dir, ".github", "workflows"), { recursive: true });
    await chmod(join(dir, ".github", "workflows"), 0o555);
    try {
      await expect(init(dir, { force: true })).rejects.toThrow("could not write .github/workflows/darnit.yml (permission denied); no file was changed");
    } finally {
      await chmod(join(dir, ".github", "workflows"), 0o755);
    }
    expect(await readFile(join(dir, "darnit.yml"), "utf8")).toBe("old\n");
    expect(await readdir(dir)).not.toContain(expect.stringMatching(/\.tmp$/));
  });

  it("removes a temporary file an earlier run left behind", async () => {
    const dir = await scratchCopy("small");
    const stale = ".darnit-0b5e2c1a-7d4f-4a6e-9c3b-2f1e8d7a6b5c.tmp";
    await writeFile(join(dir, stale), "half\n");
    await init(dir);
    expect(await readdir(dir)).not.toContain(stale);
  });

  it("leaves a file alone that appears after the check", async () => {
    const dir = await scratchCopy("small");
    const path = join(dir, "darnit.yml");
    await writeFile(path, "theirs\n");
    const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const missing = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    vi.mocked(lstat).mockImplementation((p) => (p === path ? Promise.reject(missing) : real.lstat(p)));
    try {
      expect((await init(dir)).slice(1)).toEqual(["darnit.yml exists, left unchanged (--force to rewrite)", "Wrote .github/workflows/darnit.yml"]);
    } finally {
      vi.mocked(lstat).mockImplementation(real.lstat);
    }
    expect(await readFile(path, "utf8")).toBe("theirs\n");
  });
});

describe("pinned", () => {
  it("pins the minor line before 1.0, the major line from 1.0, or the exact version for a prerelease", () => {
    expect(pinned("0.2.0")).toBe("0.2");
    expect(pinned("0.10.3")).toBe("0.10");
    expect(pinned("1.0.0")).toBe("1");
    expect(pinned("1.2.3")).toBe("1");
    expect(pinned("2.0.0-rc.1")).toBe("2.0.0-rc.1");
  });
});

describe("init never writes outside the repository", () => {
  async function outside(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "darnit-outside-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "workflows"));
    await writeFile(join(dir, "workflows", "darnit.yml"), "keep\n");
    await writeFile(join(dir, "config.yml"), "keep\n");
    return dir;
  }

  it("refuses a darnit.yml that links to a file outside", async () => {
    const [dir, out] = [await scratchCopy("small"), await outside()];
    await symlink(join(out, "config.yml"), join(dir, "darnit.yml"));
    await expect(init(dir, { force: true })).rejects.toThrow("darnit.yml is a symbolic link; darnit only writes files inside the repository");
    expect(await readFile(join(out, "config.yml"), "utf8")).toBe("keep\n");
  });

  it("refuses a .github folder that links outside, with or without --force", async () => {
    const [dir, out] = [await scratchCopy("small"), await outside()];
    await symlink(out, join(dir, ".github"));
    await expect(init(dir, { force: true })).rejects.toThrow(".github/workflows/darnit.yml is outside the repository");
    expect(await readFile(join(out, "workflows", "darnit.yml"), "utf8")).toBe("keep\n");

    await rm(join(out, "workflows"), { recursive: true });
    await expect(init(dir)).rejects.toThrow(".github/workflows/darnit.yml is outside the repository");
    expect(await readdir(out)).toEqual(["config.yml"]);
  });

  it("refuses a .github that is a file, and writes nothing", async () => {
    const dir = await scratchCopy("small");
    await writeFile(join(dir, ".github"), "not a folder\n");
    await expect(init(dir)).rejects.toThrow(".github/workflows/darnit.yml cannot be written: part of its path is a file, not a folder");
    expect(await readdir(dir)).not.toContain("darnit.yml");
  });

  it("follows a folder link that stays inside the repository", async () => {
    const dir = await scratchCopy("small");
    await mkdir(join(dir, "ci"));
    await symlink(join(dir, "ci"), join(dir, ".github"));
    await init(dir);
    expect(await readFile(join(dir, "ci", "workflows", "darnit.yml"), "utf8")).toContain("npx darnit@");
  });

  it("rewrites a hard-linked file without changing the file it shares with", async () => {
    const [dir, out] = [await scratchCopy("small"), await outside()];
    await mkdir(join(dir, ".github", "workflows"), { recursive: true });
    await link(join(out, "config.yml"), join(dir, "darnit.yml"));
    await link(join(out, "workflows", "darnit.yml"), join(dir, ".github", "workflows", "darnit.yml"));
    await git(dir, ["init", "-q"]);
    await commitAll(dir);
    expect((await init(dir, { force: true })).slice(1)).toEqual(["Rewrote darnit.yml", "Rewrote .github/workflows/darnit.yml"]);
    expect(await readFile(join(out, "config.yml"), "utf8")).toBe("keep\n");
    expect(await readFile(join(out, "workflows", "darnit.yml"), "utf8")).toBe("keep\n");
    expect(await readFile(join(dir, "darnit.yml"), "utf8")).toContain("openai:");
    expect(await readdir(dir)).not.toContain(expect.stringMatching(/\.tmp$/));
  });

  it("writes nothing when any file is refused", async () => {
    const [dir, out] = [await scratchCopy("small"), await outside()];
    await symlink(out, join(dir, ".github"));
    await expect(init(dir)).rejects.toThrow(".github/workflows/darnit.yml is outside the repository");
    expect(await readdir(dir)).not.toContain("darnit.yml");
  });

  it("refuses a .github link that points nowhere", async () => {
    const [dir, out] = [await scratchCopy("small"), await outside()];
    await symlink(join(out, "missing"), join(dir, ".github"));
    await expect(init(dir)).rejects.toThrow(".github/workflows/darnit.yml goes through a broken symbolic link; darnit only writes files inside the repository");
    expect(await readdir(out)).toEqual(["config.yml", "workflows"]);
  });

  it("says a darnit.yml link that points nowhere is a link, and leaves it", async () => {
    const [dir, out] = [await scratchCopy("small"), await outside()];
    await symlink(join(out, "missing.yml"), join(dir, "darnit.yml"));
    expect((await init(dir))[1]).toBe("darnit.yml is a symbolic link, left unchanged");
    expect(await readdir(out)).toEqual(["config.yml", "workflows"]);
  });
});

describe("init --force rewrites only what git could put back", () => {
  const OLD = { "darnit.yml": "version: 1\n", ".github/workflows/darnit.yml": "name: mine\n" };
  const REFUSED = "uncommitted changes in files init --force would rewrite: darnit.yml; commit or stash them first so git can undo the rewrite";

  it("refuses to rewrite an edited darnit.yml and keeps its bytes, then rewrites it once stashed", async () => {
    const dir = await committed("small", OLD);
    await appendFile(join(dir, "darnit.yml"), "# mine, not committed\n");
    const before = await readFile(join(dir, "darnit.yml"));
    const refused = await init(dir, { force: true }).then(() => undefined, (err: Error) => err.message);
    expect(await readFile(join(dir, "darnit.yml"), "utf8")).toBe(before.toString("utf8"));
    expect((await readFile(join(dir, "darnit.yml"))).equals(before)).toBe(true);
    expect(await readFile(join(dir, ".github/workflows/darnit.yml"), "utf8")).toBe("name: mine\n");
    expect(refused).toBe(REFUSED);
    expect((await init(dir)).slice(1)).toEqual([
      "darnit.yml exists, left unchanged (--force to rewrite)",
      ".github/workflows/darnit.yml exists, left unchanged (--force to rewrite)",
    ]);

    await git(dir, ["stash", "-q"]);
    expect((await init(dir, { force: true })).slice(1)).toEqual(["Rewrote darnit.yml", "Rewrote .github/workflows/darnit.yml"]);
    expect(await readFile(join(dir, "darnit.yml"), "utf8")).toContain("openai:");
  });

  // Each leaves darnit.yml or the workflow as git could not put it back; returns its name.
  const unsafe: [string, (dir: string) => Promise<string>][] = [
    ["edited and staged", async (dir) => {
      await appendFile(join(dir, "darnit.yml"), "# mine\n");
      await git(dir, ["add", "darnit.yml"]);
      return "darnit.yml";
    }],
    ["untracked", async (dir) => {
      await git(dir, ["rm", "-q", "--cached", "darnit.yml"]);
      await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x"]);
      return "darnit.yml";
    }],
    ["ignored", async (dir) => {
      await writeFile(join(dir, ".git", "info", "exclude"), "darnit.yml\n");
      await git(dir, ["rm", "-q", "--cached", "darnit.yml"]);
      await commitAll(dir);
      return "darnit.yml";
    }],
    ["converted to CRLF where .gitattributes stores LF", async (dir) => {
      await writeFile(join(dir, ".gitattributes"), "*.yml text eol=lf\n");
      await commitAll(dir);
      await writeFile(join(dir, "darnit.yml"), "version: 1\r\n");
      return "darnit.yml";
    }],
    ["the workflow, edited", async (dir) => {
      await appendFile(join(dir, ".github/workflows/darnit.yml"), "# mine\n");
      return ".github/workflows/darnit.yml";
    }],
  ];

  it.each(unsafe)("refuses a file that is %s, and changes neither file", async (_, setup) => {
    const dir = await committed("small", OLD);
    const file = await setup(dir);
    const before = await Promise.all(Object.keys(OLD).map((f) => readFile(join(dir, f))));
    await expect(init(dir, { force: true })).rejects.toThrow(`uncommitted changes in files init --force would rewrite: ${file}; commit or stash them first`);
    const after = await Promise.all(Object.keys(OLD).map((f) => readFile(join(dir, f))));
    expect(after.every((b, i) => b.equals(before[i]!))).toBe(true);
  });

  it("checks files by their path from a subfolder of the repository", async () => {
    const dir = await committed("small", { "app/darnit.yml": "version: 1\n" });
    await appendFile(join(dir, "app", "darnit.yml"), "# mine\n");
    await expect(init(join(dir, "app"), { force: true })).rejects.toThrow(new RegExp(`^${REFUSED}$`));
    await git(dir, ["checkout", "--", "app/darnit.yml"]);
    expect((await init(join(dir, "app"), { force: true })).slice(1)).toEqual(["Rewrote darnit.yml", "Wrote .github/workflows/darnit.yml"]);
  });

  it("checks a workflow under a .github link inside the repository by the file the link leads to", async () => {
    const dir = await committed("small", { "ci/workflows/darnit.yml": "name: mine\n" });
    await symlink("ci", join(dir, ".github"));
    await commitAll(dir);
    expect((await init(dir, { force: true })).slice(1)).toEqual(["Wrote darnit.yml", "Rewrote .github/workflows/darnit.yml"]);
    expect(await readFile(join(dir, "ci/workflows/darnit.yml"), "utf8")).toContain("npx darnit@");

    await git(dir, ["checkout", "--", "ci"]);
    await appendFile(join(dir, "ci/workflows/darnit.yml"), "# mine\n");
    await expect(init(dir, { force: true })).rejects.toThrow(/^uncommitted changes in files init --force would rewrite: \.github\/workflows\/darnit\.yml;/);
    expect(await readFile(join(dir, "ci/workflows/darnit.yml"), "utf8")).toBe("name: mine\n# mine\n");
  });

  it("says when darnit.yml differs from git's name only in case", async () => {
    const dir = await committed("small", { "Darnit.yml": "version: 1\n" });
    // Git sets core.ignorecase on a disk that ignores case, as on macOS and Windows, where this rename leaves git status clean.
    await git(dir, ["config", "core.ignorecase", "true"]);
    await rename(join(dir, "Darnit.yml"), join(dir, "darnit.yml"));
    await expect(init(dir, { force: true })).rejects.toThrow(
      /^files init --force would rewrite differ only in case from the names git has: darnit\.yml \(git has Darnit\.yml\); rename them back or commit the rename first$/,
    );
    expect(await readFile(join(dir, "darnit.yml"), "utf8")).toBe("version: 1\n");
  });

  it("leaves a file that already matches alone, committed or not, in or out of a repository", async () => {
    const dir = await scratchCopy("small");
    await init(dir);
    const before = await stat(join(dir, "darnit.yml"));
    for (const where of ["outside git", "untracked"]) {
      expect((await init(dir, { force: true })).slice(1), where).toEqual([
        "darnit.yml is up to date, left unchanged",
        ".github/workflows/darnit.yml is up to date, left unchanged",
      ]);
      await git(dir, ["init", "-q"]);
    }
    expect((await stat(join(dir, "darnit.yml"))).ino).toBe(before.ino);
  });

  it("rewrites only the file that differs when the other already matches", async () => {
    const dir = await scratchCopy("small");
    await init(dir);
    await writeFile(join(dir, "darnit.yml"), "version: 1\n");
    await git(dir, ["init", "-q"]);
    await commitAll(dir);
    expect((await init(dir, { force: true })).slice(1)).toEqual(["Rewrote darnit.yml", ".github/workflows/darnit.yml is up to date, left unchanged"]);
  });

  it("refuses to rewrite a file outside a git repository, and says how to go on", async () => {
    const dir = await scratchCopy("small");
    await writeFile(join(dir, "darnit.yml"), "mine\n");
    await expect(init(dir, { force: true })).rejects.toThrow(
      /^not a checked-out git repository, so git could not put back darnit\.yml if --force rewrote it; move it aside first, then run init again$/,
    );
    expect(await readFile(join(dir, "darnit.yml"), "utf8")).toBe("mine\n");
    expect(await readdir(dir)).not.toContain(".github");
    await mkdir(join(dir, ".github", "workflows"), { recursive: true });
    await writeFile(join(dir, ".github", "workflows", "darnit.yml"), "mine\n");
    await expect(init(dir, { force: true })).rejects.toThrow("could not put back darnit.yml, .github/workflows/darnit.yml if --force rewrote them; move them aside first");
    expect((await init(dir)).slice(1)).toEqual([
      "darnit.yml exists, left unchanged (--force to rewrite)",
      ".github/workflows/darnit.yml exists, left unchanged (--force to rewrite)",
    ]);
  });

  it("compares a darnit.yml too large to read whole without reading it", async () => {
    const dir = await committed("small", { "darnit.yml": "version: 1\n" });
    // Sparse, so it takes no disk space; reading it whole with readFile throws past 2 GiB.
    const size = 3 * 2 ** 30;
    await truncate(join(dir, "darnit.yml"), size);
    const time = await cpuTime(async () => await expect(init(dir, { force: true })).rejects.toThrow(REFUSED), 1, 2000);
    expect(time).toBeLessThan(2000);
    expect((await stat(join(dir, "darnit.yml"))).size).toBe(size);
  });
});
