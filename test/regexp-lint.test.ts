import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { copy } from "./allowlist-copy.js";

// eslint fails, anywhere it lints, the super-linear backtracking and moves the plugin can prove, and alternatives
// that overlap, which can make a regex exponential. Some exponential forms pass all three rules.

const RULES = ["regexp/no-super-linear-backtracking", "regexp/no-super-linear-move", "regexp/no-dupe-disjunctions"];
const SETTINGS: Record<string, string> = { [RULES[2]!]: '[2,{"report":"all"}]' };
// Line 1 tries every split of a run of a's between its two quantifiers; line 2 starts again at each a of a run.
// Lines 3 and 4 are exponential, and only their overlapping alternatives show it. Line 5 is exponential and its
// alternatives do not overlap, so no rule fails it.
const PLANTED = [
  "export const split = /^a*a*$/;",
  "export const moved = /a+b/;",
  "export const overlap = /^(?:\\w|\\d)+$/;",
  "export const optional = /^(a|a?)+$/;",
  "export const missed = /^(a|aa)+$/;",
].join("\n");
// Typed rules are off for .js files, so a .js file shows these three are not among them.
const FILES = ["src/planted.ts", "scripts/planted.ts", "test/planted.ts", "scripts/planted.js"];

describe("the regex rules", () => {
  it("fail proven super-linear regexes and overlapping alternatives in src/, scripts/, test/ and .js files", async () => {
    const dir = await copy();
    for (const file of FILES) await writeFile(join(dir, file), `${PLANTED}\n`);
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
          [3, RULES[2], 2],
          [4, RULES[2], 2],
        ],
      ]),
    );
  });

  it("fail in the code each shell script runs with node -e, which eslint does not lint as a file", async () => {
    const eslint = new ESLint({ ruleFilter: ({ ruleId }) => RULES.includes(ruleId) });
    const [hits, bodies]: [string[], string[]] = [[], []];
    let calls = 0;
    for (const file of (await readdir("scripts")).filter((f) => f.endsWith(".sh"))) {
      const text = await readFile(join("scripts", file), "utf8");
      calls += text.match(/\bnode\s+-e\b/g)?.length ?? 0;
      for (const body of text.matchAll(/\bnode -e '([^']*)'/g)) {
        const line = text.slice(0, body.index).split("\n").length;
        bodies.push(`${file}:${line}`);
        const [result] = await eslint.lintText(body[1]!, { filePath: "scripts/node-e.js" });
        for (const m of result!.messages) hits.push(`scripts/${file}:${line + m.line - 1} ${m.ruleId} ${m.message}`);
      }
    }
    // Every node -e is read, so a body quoted another way fails here rather than going unread.
    expect(bodies.length).toBe(calls);
    expect(calls).toBeGreaterThan(0);
    expect(hits).toEqual([]);
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
      for (const rule of RULES)
        if (JSON.stringify(rules[rule]) !== (SETTINGS[rule] ?? "[2]")) off.push(`${file} ${rule}`);
    }
    expect(off).toEqual([]);
  });
});
