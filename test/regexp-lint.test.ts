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

  it("are errors in the config resolved for every file `eslint .` lints", async () => {
    // eslint lists what it lints; with no rule run, the files need no types and the list takes seconds.
    const listed = await new ESLint({
      ruleFilter: () => false,
      overrideConfig: { languageOptions: { parserOptions: { projectService: false } } },
    }).lintFiles(["."]);
    const files = listed.map((r) => relative(process.cwd(), r.filePath).replaceAll("\\", "/"));
    expect(files).toEqual(expect.arrayContaining(["src/cli.ts", "scripts/allowlist.ts", "test/helpers.ts"]));
    expect(files).toContain("eslint.config.js");
    const eslint = new ESLint();
    const off: string[] = [];
    for (const file of files) {
      const { rules = {} } = (await eslint.calculateConfigForFile(file)) as { rules?: Record<string, unknown> };
      for (const rule of RULES) if (JSON.stringify(rules[rule]) !== "[2]") off.push(`${file} ${rule}`);
    }
    expect(off).toEqual([]);
  });
});
