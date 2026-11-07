import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";
import { problems } from "../scripts/allowlist.js";
import { readSources, type Sources } from "./import-graph.js";

// Every comment in src/ and scripts/ that turns a check off is listed in scripts/allow/suppressions.tsv with the
// reason it stays. Comments are read from each file's syntax tree, so words inside a string, a template or a regex
// are not a comment. In shell files only jscpd reads suppressions, so only its marker counts there, in any # comment.

const LIST = "scripts/allow/suppressions.tsv";
/** The tags knip skips an export for and the ends of a jscpd marker, as scripts/check-refactor.sh's grown rule has them. */
const KNIP_TAGS = ["public", "beta", "alias"];
const JSCPD_ENDS = ["start", "end"];
/** The coverage plugin's ignore hint, as scripts/check-coverage.sh counts it. */
const COVERAGE_HINT = /(?:istanbul|[cv]8|node:coverage)\s+ignore\s+(?:if|else|next|file|start|stop)(?=\W|$)/gi;
const JSCPD = new RegExp(`jscpd\\s*:\\s*ignore\\s*-\\s*(?:${JSCPD_ENDS.join("|")})`, "gi");
/** Each suppression in any case and spacing; an eslint one is named with the rules after it, up to `--`. */
const FORMS: { pattern: RegExp; rules?: boolean }[] = [
  { pattern: /eslint\s*-\s*disable(?:\s*-\s*next)?(?:\s*-\s*line)?/gi, rules: true },
  { pattern: /(?<=^\/\*\s*)eslint(?=\s+[\w@/-]+\s*:)/gi, rules: true },
  { pattern: /@\s*ts\s*-\s*(?:expect\s*-\s*error|ignore|nocheck)/gi },
  { pattern: COVERAGE_HINT },
  { pattern: JSCPD },
  { pattern: new RegExp(`@\\s*(?:${KNIP_TAGS.join("|")})(?![A-Za-z0-9_])`, "gi") },
  { pattern: /prettier\s*-\s*ignore(?:\s*-\s*(?:start|end))?/gi },
];
const SHELL = /\.sh$/;

type Comment = { text: string; line: number };

/** Each comment in `text`; in a shell file each line from its first #, over-reading quotes and words. */
function comments(file: string, text: string): Comment[] {
  if (SHELL.test(file))
    return text
      .split("\n")
      .flatMap((l, i) => (l.includes("#") ? [{ text: l.slice(l.indexOf("#")), line: i + 1 }] : []));
  return parse(/x$/.test(file) ? Lang.Tsx : Lang.TypeScript, text)
    .root()
    .findAll({ rule: { kind: "comment" } })
    .map((n) => ({ text: n.text(), line: n.range().start.line + 1 }));
}

/** The suppression `m` names: its words in lower case and single spaced, and an eslint one's rules. */
function suppression(c: Comment, m: RegExpExecArray, rules: boolean | undefined) {
  const name = m[0]
    .toLowerCase()
    .replace(/\s*([-:@])\s*/g, "$1")
    .replace(/\s+/g, " ");
  const after = rules
    ? c.text
        .slice(m.index + m[0].length)
        .split(/\n|--|\*\//)[0]!
        .trim()
    : "";
  return after ? `${name} ${after.replace(/\s+/g, " ")}` : name;
}

/** Each suppression in `sources` as its list line names it, `file<TAB>suppression<TAB>#n`, noted with its line. */
function findings(sources: Sources): Map<string, string> {
  const found = new Map<string, string>();
  for (const [file, text] of sources) {
    const forms = SHELL.test(file) ? [{ pattern: JSCPD }] : FORMS;
    const keys = comments(file, text).flatMap((c) =>
      forms.flatMap((f) =>
        [...c.text.matchAll(f.pattern)].map((m) => ({
          key: `${file}\t${suppression(c, m, f.rules)}`,
          line: c.line + c.text.slice(0, m.index).split("\n").length - 1,
        })),
      ),
    );
    keys.sort((a, b) => a.line - b.line);
    const count = new Map<string, number>();
    for (const { key, line } of keys) {
      count.set(key, (count.get(key) ?? 0) + 1);
      found.set(`${key}\t#${count.get(key)}`, `line ${line}`);
    }
  }
  return found;
}

/** Every code file under src/ and scripts/, and every shell file under scripts/. */
function sources(): Sources {
  const all = readSources();
  for (const entry of readdirSync("scripts", { recursive: true, withFileTypes: true }))
    if (entry.isFile() && SHELL.test(entry.name)) {
      const file = posix.join(entry.parentPath.split("\\").join("/"), entry.name);
      all.set(file, readFileSync(file, "utf8"));
    }
  return all;
}

const list = readFileSync(LIST, "utf8");
const check = (files: Sources, text = list) => problems(LIST, text, 3, () => findings(files));
/** The problems with `files` once `file` holds `text`. */
const withFile = (file: string, text: string) => check(new Map([...sources(), [file, text]]));
const missing = (key: string) => `not in ${LIST}: ${key}`;
const STAYS = "; remove it, or add the line with the reason it stays";

describe("suppression comments", () => {
  it("in src/ and scripts/ are each listed, with a reason, and every line names one still there", () => {
    expect(check(sources())).toEqual([]);
  });

  const clean = readFileSync("src/refusal.ts", "utf8");
  it.each([
    ["// eslint-disable-next-line no-eval", "eslint-disable-next-line no-eval"],
    ["/* eslint-disable */", "eslint-disable"],
    ["/*eslint-disable*/", "eslint-disable"],
    ["// ESLint-Disable", "eslint-disable"],
    ["x; // eslint-disable-line no-eval -- why", "eslint-disable-line no-eval"],
    ["/* eslint -\n  disable  no-eval */", "eslint-disable no-eval"],
    ["/* eslint no-eval: off */", "eslint no-eval: off"],
    ["// @ts-expect-error", "@ts-expect-error"],
    ["// @ts-ignore: why", "@ts-ignore"],
    ["/* @TS-Ignore */", "@ts-ignore"],
    ["// @ts-nocheck", "@ts-nocheck"],
    ["/* c8 ignore next */", "c8 ignore next"],
    ["// C8  ignore  NEXT 2", "c8 ignore next"],
    ["/* v8 ignore start */", "v8 ignore start"],
    ["/* istanbul\n   ignore else */", "istanbul ignore else"],
    ["/* node:coverage ignore next */", "node:coverage ignore next"],
    ["// jscpd:ignore-start", "jscpd:ignore-start"],
    ["/* JSCPD : ignore - end */", "jscpd:ignore-end"],
    ["/** @public */", "@public"],
    ["/**\n * A thing.\n * @beta\n */", "@beta"],
    ["/** @alias other */", "@alias"],
    ["// prettier-ignore", "prettier-ignore"],
    ["/* Prettier-Ignore */", "prettier-ignore"],
  ])("fail when %j is added to a clean file", (comment, name) => {
    expect(withFile("src/refusal.ts", `${clean}\n${comment}\nexport const x = 1;\n`)).toEqual([
      expect.stringContaining(missing(`src/refusal.ts\t${name}\t#1`)),
    ]);
  });

  it("are found in a script and in a nested folder too", () => {
    expect(withFile("scripts/x/new.ts", "// @ts-ignore\n")).toEqual([
      `${missing("scripts/x/new.ts\t@ts-ignore\t#1 (line 1)")}${STAYS}`,
    ]);
  });

  it("are not words in a string, a template, a regex or code", () => {
    const code = [
      `const a = "// eslint-disable-next-line no-eval /* @ts-ignore */";`,
      "const b = `/* c8 ignore next */ ${a} // @public`;",
      String.raw`const c = /\/\/ prettier-ignore|jscpd:ignore-start/;`,
      `const d = { "@ts-nocheck": 1, eslint: "disable" };`,
    ].join("\n");
    expect(withFile("src/refusal.ts", `${clean}\n${code}\n`)).toEqual([]);
  });

  it("are numbered within a file without lines, so a second copy is new, a moved one is not and a rule is part of it", () => {
    const fix = readFileSync("src/fix.ts", "utf8");
    expect(withFile("src/fix.ts", `\n\n${fix}`)).toEqual([]);
    expect(withFile("src/fix.ts", `${fix}\n// eslint-disable-next-line no-control-regex\n`)).toEqual([
      expect.stringContaining(missing("src/fix.ts\teslint-disable-next-line no-control-regex\t#3")),
    ]);
    const plan = readFileSync("src/plan.ts", "utf8").replace("line no-control-regex", "line no-control-regex, no-eval");
    expect(withFile("src/plan.ts", plan)).toEqual([
      expect.stringContaining(missing("src/plan.ts\teslint-disable-next-line no-control-regex, no-eval\t#1")),
      expect.stringContaining("src/plan.ts\teslint-disable-next-line no-control-regex\t#1; remove the line"),
    ]);
  });

  it("fail a list line whose comment is gone, and a line without a reason", () => {
    expect(check(sources(), `${list}src/refusal.ts\t@ts-ignore\t#1\twhy\n`)).toEqual([
      `${LIST}:12 is no longer found: src/refusal.ts\t@ts-ignore\t#1; remove the line`,
    ]);
    expect(check(sources(), `${list}src/refusal.ts\t@ts-ignore\t#1\n`)).toEqual([
      `${LIST}: line 12 needs 3 fields and a reason, tab separated`,
    ]);
  });
});

describe("suppressions in shell files", () => {
  it("are jscpd's marker in a comment, the one suppression a tool reads there", () => {
    const script = "#!/bin/sh\necho a # JSCPD:ignore-start\n# @public eslint-disable @ts-ignore c8 ignore next\n";
    expect(withFile("scripts/new.sh", script)).toEqual([
      `${missing("scripts/new.sh\tjscpd:ignore-start\t#1 (line 2)")}${STAYS}`,
    ]);
  });

  it.each([
    ["scripts/check-refactor.sh", /# .*@public.*jscpd:ignore marker/],
    ["scripts/check-coverage.sh", /\(\?:istanbul\|\[cv\]8\|node:coverage\)\\s\+ignore/],
  ])("leave %s alone, which names them in its own comments and code", (file, words) => {
    const text = readFileSync(file, "utf8");
    expect(text).toMatch(words);
    expect([...findings(new Map([[file, text]])).keys()]).toEqual([]);
  });

  it("match what scripts/check-refactor.sh and scripts/check-coverage.sh look for", () => {
    const refactor = readFileSync("scripts/check-refactor.sh", "utf8");
    expect(refactor).toContain(`/@(${KNIP_TAGS.join("|")})([^A-Za-z0-9_]|$)/`);
    expect(refactor).toContain(`/jscpd:ignore-(${JSCPD_ENDS.join("|")})/`);
    expect(readFileSync("scripts/check-coverage.sh", "utf8")).toContain(`const hint = ${String(COVERAGE_HINT)};`);
  });
});
