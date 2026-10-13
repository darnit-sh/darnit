import { execFileSync } from "node:child_process";
import type { Stats } from "node:fs";
import { cp, type FileHandle, link, mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectApis, MAX_FILE_BYTES, readText } from "../src/detect.js";
import { init, pinned } from "../src/init.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return { ...real, stat: vi.fn(real.stat) };
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
    const start = performance.now();
    expect((await detectApis(dir)).map((d) => d.vendor)).toEqual(["openai"]);
    expect(performance.now() - start).toBeLessThan(2000);
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
    expect(workflow).toContain(`- run: npx darnit@${pinned(version)} check\n`);

    const second = await init(dir);
    expect(second.slice(1)).toEqual([
      "darnit.yml exists, left unchanged (--force to rewrite)",
      ".github/workflows/darnit.yml exists, left unchanged (--force to rewrite)",
    ]);
    expect(await readFile(join(dir, "darnit.yml"), "utf8")).toBe(yml);

    const forced = await init(dir, { force: true });
    expect(forced.slice(1)).toEqual(["Rewrote darnit.yml", "Rewrote .github/workflows/darnit.yml"]);
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
