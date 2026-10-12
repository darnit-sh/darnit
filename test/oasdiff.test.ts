import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assetName, changelog, oasdiffBinary } from "../src/corpus/oasdiff.js";

const YAML_DIR = fileURLToPath(new URL("./fixtures/specs/", import.meta.url));

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("oasdiff", () => {
  it("picks the release asset for the platform", () => {
    expect(assetName("darwin", "arm64")).toBe("oasdiff_1.32.1_darwin_all.tar.gz");
    expect(assetName("darwin", "x64")).toBe("oasdiff_1.32.1_darwin_all.tar.gz");
    expect(assetName("linux", "x64")).toBe("oasdiff_1.32.1_linux_amd64.tar.gz");
    expect(assetName("linux", "arm64")).toBe("oasdiff_1.32.1_linux_arm64.tar.gz");
    expect(assetName("win32", "x64")).toBe("oasdiff_1.32.1_windows_amd64.tar.gz");
    expect(assetName("win32", "arm64")).toBe("oasdiff_1.32.1_windows_arm64.tar.gz");
  });

  it("refuses a release archive that differs from the pinned one, even with a matching checksums file", async () => {
    const home = mkdtempSync(join(tmpdir(), "darnit-home-"));
    const src = mkdtempSync(join(tmpdir(), "darnit-fake-"));
    tempDirs.push(home, src);
    writeFileSync(join(src, "oasdiff"), "#!/bin/sh\ntouch planted\n", { mode: 0o755 });
    execFileSync("tar", ["-czf", join(src, "fake.tar.gz"), "-C", src, "oasdiff"]);
    const archive = readFileSync(join(src, "fake.tar.gz"));
    const checksums = `${createHash("sha256").update(archive).digest("hex")}  ${assetName()}\n`;
    vi.stubEnv("HOME", home);
    vi.stubEnv("OASDIFF", "");
    vi.stubEnv("PATH", "/usr/bin:/bin");
    vi.stubGlobal("fetch", (url: string) => Promise.resolve(new Response(url.endsWith("checksums.txt") ? checksums : archive)));

    await expect(oasdiffBinary()).rejects.toThrow(/checksum mismatch/);
    expect(existsSync(join(home, ".cache", "darnit"))).toBe(false);
  });

  it("reports deprecations and removals between two specs", async () => {
    const entries = await changelog(`${YAML_DIR}before.yaml`, `${YAML_DIR}after.yaml`);
    const ids = entries.map((e) => `${e.id} ${e.text.match(/`([^`]+)`/)?.[1] ?? e.path}`).sort();
    expect(ids).toEqual(
      expect.arrayContaining([
        "request-property-deprecated max_tokens",
        "request-property-deprecated functions",
        "request-property-removed old_name",
        "api-path-removed-without-deprecation /edits",
      ]),
    );
    expect(await changelog(`${YAML_DIR}before.yaml`, `${YAML_DIR}before.yaml`)).toEqual([]);
  });
});
