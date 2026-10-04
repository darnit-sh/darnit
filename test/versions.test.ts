import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atLeast, npmVersionFor, pypiVersions } from "../src/versions.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function dirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "darnit-versions-"));
  tempDirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  return dir;
}

const installed = (version: string) => JSON.stringify({ version });
const lock = (entries: Record<string, string>) =>
  JSON.stringify({ packages: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, { version: v }])) });

describe("atLeast", () => {
  it("compares numerically, not as text", () => {
    expect(atLeast("1.45.0", "1.45.0")).toBe(true);
    expect(atLeast("1.100.0", "1.45.0")).toBe(true);
    expect(atLeast("1.44.9", "1.45.0")).toBe(false);
    expect(atLeast("4.9.0", "4.60.0")).toBe(false);
    expect(atLeast("5.0.0", "4.60.0")).toBe(true);
  });

  it("puts a prerelease of the minimum below it", () => {
    expect(atLeast("4.60.0-beta.1", "4.60.0")).toBe(false);
    expect(atLeast("1.45.0rc1", "1.45.0")).toBe(false);
    expect(atLeast("4.61.0-beta.1", "4.60.0")).toBe(true);
  });
});

describe("npmVersionFor", () => {
  it("prefers what is installed over what is locked", async () => {
    const dir = await dirWith({
      "node_modules/openai/package.json": installed("4.70.1"),
      "package-lock.json": lock({ "node_modules/openai": "4.20.0" }),
    });
    expect(await npmVersionFor(dir, "openai", "src/a.js")).toEqual({ version: "4.70.1", from: "node_modules/openai" });
  });

  it("uses the install nearest the file, as Node does, so a monorepo's hoisted old copy cannot block", async () => {
    const dir = await dirWith({
      "node_modules/openai/package.json": installed("4.20.0"),
      "apps/web/node_modules/openai/package.json": installed("4.70.0"),
    });
    expect(await npmVersionFor(dir, "openai", "apps/web/src/chat.ts")).toEqual({ version: "4.70.0", from: "apps/web/node_modules/openai" });
    expect(await npmVersionFor(dir, "openai", "apps/api/chat.ts")).toEqual({ version: "4.20.0", from: "node_modules/openai" });
  });

  it("reads the nearest package-lock.json entry when nothing is installed", async () => {
    const dir = await dirWith({ "package-lock.json": lock({ "node_modules/openai": "4.20.0", "apps/web/node_modules/openai": "4.70.0" }) });
    expect(await npmVersionFor(dir, "openai", "apps/web/chat.ts")).toEqual({ version: "4.70.0", from: "package-lock.json" });
    expect(await npmVersionFor(dir, "openai", "chat.ts")).toEqual({ version: "4.20.0", from: "package-lock.json" });
  });

  it("says nothing when nothing says", async () => {
    expect(await npmVersionFor(await dirWith({ "package.json": "{}" }), "openai", "a.js")).toBeUndefined();
  });
});

describe("pypiVersions", () => {
  it("reads exact pins, requirements.txt first, ignoring ranges, markers and other packages", async () => {
    const dir = await dirWith({
      "requirements-legacy.txt": "openai==0.28.1\n",
      "requirements.txt": "openai-whisper==20231117\nhttpx>=0.27\nOpenAI[datalib] == 1.50.0 ; python_version >= '3.8'  # pinned\r\n",
    });
    expect(await pypiVersions(dir, "openai")).toEqual([{ version: "1.50.0", from: "requirements.txt" }]);
    expect(await pypiVersions(await dirWith({ "requirements.txt": "openai>=1.0\n" }), "openai")).toEqual([]);
  });

  it("trusts requirements.txt, then a lock file, over side requirements files", async () => {
    const block = `[[package]]\nname = "openai"\nversion = "1.52.0"\n`;
    const sideOnly = await dirWith({ "requirements-dev.txt": "openai==1.40.0\n" });
    expect(await pypiVersions(sideOnly, "openai")).toEqual([{ version: "1.40.0", from: "requirements-dev.txt" }]);
    const withLock = await dirWith({ "requirements-dev.txt": "openai==1.40.0\n", "poetry.lock": block });
    expect(await pypiVersions(withLock, "openai")).toEqual([{ version: "1.52.0", from: "poetry.lock" }]);
  });

  it("reads every matching block in poetry.lock and uv.lock", async () => {
    const block = (name: string, version: string) => `[[package]]\nname = "${name}"\nversion = "${version}"\n`;
    expect(await pypiVersions(await dirWith({ "poetry.lock": block("httpx", "0.27.0") + block("openai", "1.51.2") }), "openai")).toEqual([
      { version: "1.51.2", from: "poetry.lock" },
    ]);
    expect(await pypiVersions(await dirWith({ "uv.lock": block("openai", "1.30.5") + block("openai", "1.52.0") }), "openai")).toEqual([
      { version: "1.30.5", from: "uv.lock" },
      { version: "1.52.0", from: "uv.lock" },
    ]);
  });
});
