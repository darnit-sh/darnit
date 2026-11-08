import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { copy } from "./allowlist-copy.js";

// A regex whose time grows faster than its text hangs on crafted input; eslint fails one anywhere it lints.

const RULES = ["regexp/no-super-linear-backtracking", "regexp/no-super-linear-move"];
// Line 1 tries every split of a run of a's between its two quantifiers; line 2 starts again at each a of a run.
const PLANTED = "export const split = /^a*a*$/;\nexport const moved = /a+b/;\n";
// Typed rules are off for .js files, so a .js file shows these two are not among them.
const FILES = ["src/planted.ts", "scripts/planted.ts", "test/planted.ts", "scripts/planted.js"];

describe("the regex rules", () => {
  it("fail a regex of each kind planted in src/, scripts/ and test/, and in a .js file", async () => {
    const dir = await copy();
    for (const file of FILES) await writeFile(join(dir, file), PLANTED);
    const results = await new ESLint({ cwd: dir }).lintFiles(FILES);
    expect(
      results.map((r) => [
        relative(dir, r.filePath).replaceAll("\\", "/"),
        r.messages.filter((m) => !m.ruleId || RULES.includes(m.ruleId)).map((m) => [m.line, m.ruleId, m.severity]),
      ]),
    ).toEqual(
      FILES.map((file) => [
        file,
        [
          [1, RULES[0], 2],
          [2, RULES[1], 2],
        ],
      ]),
    );
  });

  it("are errors in the config resolved for code in src/, scripts/ and test/, and for a .js file", async () => {
    const eslint = new ESLint();
    for (const file of ["src/cli.ts", "scripts/allowlist.ts", "test/helpers.ts", "eslint.config.js"]) {
      const { rules = {} } = (await eslint.calculateConfigForFile(file)) as { rules?: Record<string, unknown> };
      expect([file, ...RULES.map((rule) => rules[rule])]).toEqual([file, [2], [2]]);
    }
  });
});
