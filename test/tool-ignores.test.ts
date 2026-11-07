import { readdirSync, readFileSync } from "node:fs";
import type { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import { configKeys } from "../scripts/allowlist.js";

// What each check leaves out, pinned here, so widening one changes this test beside the config in plain sight.

describe("what the checks leave out", () => {
  it("is knip.json, whole", () => {
    expect(JSON.parse(readFileSync("knip.json", "utf8"))).toEqual({
      $schema: "https://unpkg.com/knip@6/schema.json",
      entry: ["scripts/*.ts", "test/**/*.test.ts", "test/helpers.ts", "test/offer-graph.ts"],
      project: ["src/**/*.ts", "scripts/**/*.ts", "test/**/*.ts", "!test/samples/**", "!test/e2e/**"],
      vitest: { config: ["vitest.config.ts"] },
      eslint: { config: ["eslint.config.js"] },
    });
  });

  it("is the one ignores block in eslint.config.js", async () => {
    // A path in a variable, as the config has no types for the import to check.
    const file = "../eslint.config.js";
    const { default: config } = (await import(file)) as { default: Linter.Config[] };
    expect(config.filter((c) => c.ignores)).toEqual([
      {
        ignores: ["dist/", "node_modules/", "coverage/", "packs/**/fixtures/**", "test/samples/**", "test/e2e/**"],
      },
    ]);
  });

  it("is .prettierignore's lines", () => {
    const lines = readFileSync(".prettierignore", "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.startsWith("#"));
    expect(lines).toEqual([
      "*",
      "!*/",
      ...["ts", "js", "mjs", "cjs", "mts", "cts", "tsx", "jsx"].map((ext) => `!*.${ext}`),
      "dist/",
      "node_modules/",
      "coverage/",
      "packs/**/fixtures/**",
      "test/fixtures/**",
      "test/samples/**",
      "test/e2e/**",
      "test/golden/**",
      "corpus/**",
    ]);
  });

  it("is set nowhere else: no knip or jscpd key in package.json and no .jscpd.json, in any case", () => {
    expect(configKeys(".")).toEqual([]);
    expect(readdirSync(".").filter((f) => f.toLowerCase() === ".jscpd.json")).toEqual([]);
  });
});
