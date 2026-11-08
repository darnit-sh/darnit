import { existsSync } from "node:fs";
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

// eslint lints files, not the code a shell script hands node, so the code in each `node -e '<body>'` is linted here,
// with comments that turn a rule off ignored. Every other way of running node fails, naming its form, since this
// test cannot find that code: node on a .js or .ts file under scripts/ is fine, as eslint lints the file itself.
const BODY = /\bnode -e '([^']*)'(?=[\s)|;&]|$)/g;
const NODE = /(?<=^|[\s/("'`;|&{=])node(?=$|[\s"'`;|&)\\])/g;
const FORMS: [RegExp, string][] = [
  [/^node -e '/, "runs node -e with a ' in its body or another string after it"],
  [/^node[ \t]*\\\n/, "runs node with its arguments on the next line"],
  [/^node\s+(-e|--eval)\b/, "runs node -e or --eval with a body that is not written as node -e '<body>'"],
  [/^node\s+(-p|--print)\b/, "runs node -p; print with console.log in node -e '<body>'"],
  [/^node\s*(-(\s|$)|<|$|[|;&)])/, "runs node on code from stdin or a heredoc"],
  [/^node\s+-/, "runs node with an option before -e"],
];
const OTHER = "runs node on something other than a .js or .ts file under scripts/ that eslint lints";

async function nodeProblems(files: readonly (readonly [string, string])[]) {
  const eslint = new ESLint({ allowInlineConfig: false, ruleFilter: ({ ruleId }) => RULES.includes(ruleId) });
  const lineOf = (text: string, at: number) => text.slice(0, at).split("\n").length;
  const problems: string[] = [];
  let bodies = 0;
  for (const [file, text] of files) {
    for (const body of text.matchAll(BODY)) {
      bodies++;
      const [result] = await eslint.lintText(body[1]!, { filePath: "scripts/node-e.js" });
      const line = lineOf(text, body.index);
      for (const m of result!.messages) problems.push(`${file}:${line + m.line - 1} ${m.ruleId ?? m.message}`);
    }
    const rest = text.replace(BODY, (call) => call.replace(/[^\n]/g, " "));
    for (const run of rest.matchAll(NODE)) {
      const from = rest.slice(run.index);
      const form = FORMS.find(([re]) => re.test(from))?.[1];
      const script = /^node\s+(scripts\/[\w./-]+\.[jt]s)(?=[\s;|&)]|$)/.exec(from)?.[1];
      const linted = !form && script && existsSync(script) && !(await eslint.isPathIgnored(script));
      if (!linted) problems.push(`${file}:${lineOf(rest, run.index)} ${form ?? OTHER}`);
    }
  }
  return { problems, bodies };
}

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

  it(
    "fail in each script's node -e body, as node may run in scripts/*.sh only as node -e '<body>' with no ' in it, " +
      "or on a .js or .ts file under scripts/ that eslint lints",
    async () => {
      const files = (await readdir("scripts")).filter((f) => f.endsWith(".sh"));
      const read = await Promise.all(files.map(async (f) => [f, await readFile(join("scripts", f), "utf8")] as const));
      const { problems, bodies } = await nodeProblems(read);
      expect(problems).toEqual([]);
      expect(bodies).toBeGreaterThan(0);
    },
  );

  it("fail a node -e body that turns a rule off in a comment, and every other way of running node", async () => {
    const regex = "console.log(/^(a|a?)+$/.test(process.argv[1]));";
    const planted: [string, string][] = [
      ["off.sh", `node -e '\n// eslint-disable-next-line regexp/no-dupe-disjunctions\n${regex}\n' "$1"\n`],
      ["quotes.sh", `node -e 'console.log("'"'"'x'"'"'")' "$1"\n`],
      ["print.sh", "node -p 'process.argv[1]' x\n"],
      ["eval.sh", "node --eval 'console.log(1)'\n"],
      ["option.sh", "node --input-type=commonjs -e 'console.log(1)'\n"],
      ["next-line.sh", "node \\\n  -e 'console.log(1)'\n"],
      ["heredoc.sh", `node - <<'EOF'\n${regex}\nEOF\n`],
      ["file.sh", "node scripts/limits.ts\nnode /tmp/x.js\n"],
    ];
    expect((await nodeProblems(planted)).problems).toEqual([
      "off.sh:3 regexp/no-dupe-disjunctions",
      `quotes.sh:1 ${FORMS[0]![1]}`,
      `print.sh:1 ${FORMS[3]![1]}`,
      `eval.sh:1 ${FORMS[2]![1]}`,
      `option.sh:1 ${FORMS[5]![1]}`,
      `next-line.sh:1 ${FORMS[1]![1]}`,
      `heredoc.sh:1 ${FORMS[4]![1]}`,
      `file.sh:2 ${OTHER}`,
    ]);
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
