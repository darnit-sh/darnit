import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atLeast, installedVersion } from "../src/versions.js";

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

describe("atLeast", () => {
  it("compares numerically, not as text", () => {
    expect(atLeast("1.45.0", "1.45.0")).toBe(true);
    expect(atLeast("1.100.0", "1.45.0")).toBe(true);
    expect(atLeast("1.44.9", "1.45.0")).toBe(false);
    expect(atLeast("4.9.0", "4.60.0")).toBe(false);
    expect(atLeast("5.0.0", "4.60.0")).toBe(true);
  });
});

describe("installedVersion", () => {
  it("prefers what is installed over what is locked for npm", async () => {
    const dir = await dirWith({
      "node_modules/openai/package.json": JSON.stringify({ version: "4.70.1" }),
      "package-lock.json": JSON.stringify({ packages: { "node_modules/openai": { version: "4.20.0" } } }),
    });
    expect(await installedVersion(dir, "npm", "openai")).toEqual({ version: "4.70.1", from: "node_modules/openai" });
  });

  it("falls back to package-lock.json", async () => {
    const dir = await dirWith({ "package-lock.json": JSON.stringify({ packages: { "node_modules/openai": { version: "4.20.0" } } }) });
    expect(await installedVersion(dir, "npm", "openai")).toEqual({ version: "4.20.0", from: "package-lock.json" });
  });

  it("reads exact pins from requirements files, ignoring ranges and other packages", async () => {
    const dir = await dirWith({ "requirements.txt": "openai-whisper==20231117\nhttpx>=0.27\nOpenAI[datalib] == 1.40.0  # pinned\n" });
    expect(await installedVersion(dir, "pypi", "openai")).toEqual({ version: "1.40.0", from: "requirements.txt" });
    expect(await installedVersion(await dirWith({ "requirements.txt": "openai>=1.0\n" }), "pypi", "openai")).toBeUndefined();
  });

  it("reads poetry.lock and uv.lock", async () => {
    const block = (name: string, version: string) => `[[package]]\nname = "${name}"\nversion = "${version}"\n`;
    expect(await installedVersion(await dirWith({ "poetry.lock": block("httpx", "0.27.0") + block("openai", "1.51.2") }), "pypi", "openai")).toEqual({
      version: "1.51.2",
      from: "poetry.lock",
    });
    expect(await installedVersion(await dirWith({ "uv.lock": block("openai", "1.30.5") }), "pypi", "openai")).toEqual({ version: "1.30.5", from: "uv.lock" });
  });

  it("says nothing when nothing says", async () => {
    expect(await installedVersion(await dirWith({ "package.json": "{}" }), "npm", "openai")).toBeUndefined();
    expect(await installedVersion(await dirWith({ "package-lock.json": "not json" }), "npm", "openai")).toBeUndefined();
    expect(await installedVersion(await dirWith({}), "pypi", "openai")).toBeUndefined();
  });
});
