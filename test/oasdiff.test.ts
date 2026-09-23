import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assetName, changelog } from "../src/corpus/oasdiff.js";

const SPECS = fileURLToPath(new URL("./fixtures/specs/", import.meta.url));

describe("oasdiff", () => {
  it("picks the release asset for the platform", () => {
    expect(assetName("darwin", "arm64")).toBe("oasdiff_1.32.1_darwin_all.tar.gz");
    expect(assetName("darwin", "x64")).toBe("oasdiff_1.32.1_darwin_all.tar.gz");
    expect(assetName("linux", "x64")).toBe("oasdiff_1.32.1_linux_amd64.tar.gz");
    expect(assetName("linux", "arm64")).toBe("oasdiff_1.32.1_linux_arm64.tar.gz");
    expect(assetName("win32", "x64")).toBe("oasdiff_1.32.1_windows_amd64.tar.gz");
  });

  it("reports deprecations and removals between two specs", async () => {
    const entries = await changelog(`${SPECS}before.yaml`, `${SPECS}after.yaml`);
    const ids = entries.map((e) => `${e.id} ${e.text.match(/`([^`]+)`/)?.[1] ?? e.path}`).sort();
    expect(ids).toEqual(
      expect.arrayContaining([
        "request-property-deprecated max_tokens",
        "request-property-deprecated functions",
        "request-property-removed old_name",
        "api-path-removed-without-deprecation /edits",
      ]),
    );
    expect(await changelog(`${SPECS}before.yaml`, `${SPECS}before.yaml`)).toEqual([]);
  });
});
