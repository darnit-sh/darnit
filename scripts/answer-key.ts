import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { recordNames } from "../src/check.js";
import { listFiles, readText } from "../src/detect.js";
import { loadRecords } from "../src/records/load.js";
import { isBinary, isCodeFile, LONG_LINE } from "../src/scan/mentions.js";
import { NAMED } from "../src/scan/values.js";
import { CLONES, clone, esc, parseRows, runCheck, type Report } from "./golden.js";

// Checks the model names darnit reports on the pinned golden repositories against a plain fixed-string search for
// every model id in the records, over the same files. A line only one side has must fit a rule below, or it fails.
// Usage: npm run answer-key [-- --dir <clones>]

/** Why the plain search finds an id on a line darnit does not report, tried in this order on each place it is found. */
export const RULES = {
  "call site": "the line is in a call site darnit reports, whose code holds the id",
  "longer id": "inside a longer id darnit reports on the line, counted once as the longer",
  "longer name": "inside a longer name that is not an id, such as gpt-4o-custom or my_gpt-4",
  "letters only": "an id of letters only, such as ada, outside quotes and not the whole value of a model or engine setting",
  "long line": `an id such as o1 on a line over ${LONG_LINE} characters, outside quotes and not a setting value`,
  "code name": "an id such as o1 in code, with no comment or string open where it sits",
} as const;
export type Rule = keyof typeof RULES;

export type Miss = { file: string; line: number; id: string; side: "darnit" | "search" };
export type Tally = { mentions: number; agreed: number; explained: Partial<Record<Rule, number>>; unexplained: Miss[] };

const NAME_BEFORE = /[\p{L}\p{M}\p{N}_.-]$/u;
const NAME_AFTER = /^[\p{L}\p{M}\p{N}_-]/u;
const ALNUM = /^[\p{L}\p{M}\p{N}]/u;
const LETTERS = /^\p{L}+$/u;
const IDENTIFIER = /^[\p{L}\p{M}\p{N}_]+$/u;
const LINE_END = /[ \t]*\r?(?:\n|$)/y;

/** Indexes of every `needle` in `text`, overlapping ones too. */
function indexes(text: string, needle: string): number[] {
  const out: number[] = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) out.push(at);
  return out;
}

/** How many of the sorted `list` are below `at`. */
function below(list: readonly number[], at: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Whether the id at s..e is the whole value of a setting whose key names a model or engine, as `model: ada`; reads at most 200 characters back. */
function setting(text: string, s: number, e: number): boolean {
  LINE_END.lastIndex = e;
  if (!LINE_END.test(text)) return false;
  let i = s;
  while (i > 0 && " \t".includes(text[i - 1]!)) i--;
  if (i === 0 || !"=:".includes(text[i - 1]!)) return false;
  i--;
  while (i > 0 && " \t".includes(text[i - 1]!)) i--;
  const keyEnd = i;
  while (i > 0 && keyEnd - i < 200 && NAME_BEFORE.test(text.slice(Math.max(0, i - 2), i))) i--;
  return NAMED.test(text.slice(i, keyEnd));
}

/** Whether the id at s..e sits directly in quotes, plain or escaped as in a JSON string. */
function quoted(text: string, s: number, e: number): boolean {
  const q = text.charAt(s - 1);
  if (!q || !"\"'`".includes(q)) return false;
  return text.charAt(s - 2) === "\\" ? text.startsWith(`\\${q}`, e) : text.charAt(e) === q;
}

/** The rules for one file's text; `marks` finds each delimiter once, so a file full of ids is still read in linear time. */
function rules(file: string, text: string, newlines: readonly number[], reported: (line: number) => ReadonlySet<string>) {
  const found = new Map<string, number[]>();
  const marks = (d: string) => found.get(d) ?? found.set(d, indexes(text, d)).get(d)!;
  const even = (d: string, at: number) => below(marks(d), at) % 2 === 0;
  const inCode = (s: number, lineStart: number) => {
    const before = text.slice(lineStart, s);
    if (/["'`#]|\/[/*]/.test(before) || /^\s*\*/.test(before)) return false;
    const opened = below(marks("/*"), s);
    return ['"""', "'''", "`"].every((d) => even(d, s)) && (opened === 0 || marks("*/")[below(marks("*/"), s) - 1]! > marks("/*")[opened - 1]!);
  };
  /** The rule that explains the id at s, on `line`, or undefined. */
  return (line: number, id: string, s: number): Rule | undefined => {
    const e = s + id.length;
    const touching = NAME_BEFORE.test(text.slice(Math.max(0, s - 2), s)) || NAME_AFTER.test(text.slice(e, e + 2)) || (text[e] === "." && ALNUM.test(text.slice(e + 1, e + 3)));
    if (touching) {
      const longer = [...reported(line)].some((r) => r.length > id.length && indexes(r, id).some((k) => text.startsWith(r, s - k)));
      return longer ? "longer id" : "longer name";
    }
    if (!IDENTIFIER.test(id) || quoted(text, s, e) || setting(text, s, e)) return undefined;
    const lineStart = line === 1 ? 0 : newlines[line - 2]! + 1;
    const lineEnd = line - 1 < newlines.length ? newlines[line - 1]! : text.length;
    if (LETTERS.test(id)) return "letters only";
    if (lineEnd - lineStart > LONG_LINE) return "long line";
    return isCodeFile(file) && inCode(s, lineStart) ? "code name" : undefined;
  };
}

const key = (file: string, line: number, id: string) => JSON.stringify([file, line, id]);

/** darnit's model-name findings in `report` joined with a plain search for `ids` over the same files under `root`. */
export async function answerKey(root: string, report: Report, ids: ReadonlySet<string>): Promise<Tally> {
  const left = [...(report.scanned.tooLarge ?? []), ...(report.scanned.skipped ?? []).map((k) => k.path)];
  const notChecked = (file: string) => left.some((p) => p === "." || file === p || file.startsWith(`${p}/`));
  const darnit = new Map<string, Map<number, Set<string>>>();
  for (const m of [...report.mentions, ...report.possiblyAffected]) {
    if (notChecked(m.file)) continue;
    const lines = darnit.get(m.file) ?? darnit.set(m.file, new Map()).get(m.file)!;
    (lines.get(m.line) ?? lines.set(m.line, new Set()).get(m.line)!).add(m.model);
  }
  const t: Tally = { mentions: 0, agreed: 0, explained: {}, unexplained: [] };
  const seen = new Set<string>();
  const sitesIn = new Map<string, { from: number; to: number; text: string }[]>();
  for (const h of report.hits) (sitesIn.get(h.file) ?? sitesIn.set(h.file, []).get(h.file)!).push({ from: h.line, to: h.line + indexes(h.text, "\n").length, text: h.text });
  for (const file of await listFiles(root)) {
    if (notChecked(file)) continue;
    const text = await readText(join(root, file));
    if (text === undefined || isBinary(text)) continue;
    const reported = darnit.get(file) ?? new Map<number, Set<string>>();
    const newlines = indexes(text, "\n");
    const explain = rules(file, text, newlines, (line) => reported.get(line) ?? new Set());
    const sites = sitesIn.get(file) ?? [];
    for (const id of ids) {
      const byLine = new Map<number, number[]>();
      for (const at of indexes(text, id)) {
        const line = below(newlines, at) + 1;
        (byLine.get(line) ?? byLine.set(line, []).get(line)!).push(at);
      }
      for (const [line, starts] of byLine) {
        t.mentions++;
        seen.add(key(file, line, id));
        if (reported.get(line)?.has(id)) {
          t.agreed++;
          continue;
        }
        const site = sites.some((h) => h.from <= line && line <= h.to && h.text.includes(id));
        const why = site ? ["call site" as const] : starts.map((s) => explain(line, id, s));
        if (why.every((w) => w !== undefined)) t.explained[why[0]!] = (t.explained[why[0]!] ?? 0) + 1;
        else t.unexplained.push({ file, line, id, side: "search" });
      }
    }
  }
  for (const [file, lines] of darnit)
    for (const [line, models] of lines)
      for (const id of models)
        if (!seen.has(key(file, line, id))) {
          t.mentions++;
          t.unexplained.push({ file, line, id, side: "darnit" });
        }
  return t;
}

/** One line of counts, rules in table order. */
export function summary(t: Tally): string {
  const rules = (Object.keys(RULES) as Rule[]).filter((r) => t.explained[r]).map((r) => `${r} ${t.explained[r]}`);
  const explained = Object.values(t.explained).reduce((a, b) => a + b, 0);
  return `mentions ${t.mentions}, agreed ${t.agreed}, explained ${explained}${rules.length > 0 ? ` (${rules.join(", ")})` : ""}, unexplained ${t.unexplained.length}`;
}

/** Each line only one side has with no rule for it. */
export const misses = (t: Tally) => t.unexplained.map((u) => `${esc(u.file)}:${u.line} ${u.id} only in ${u.side}`);

/** 1 when any line is unexplained or a repository could not be compared. */
export const exitCode = (t: Tally, errors: readonly string[] = []) => (t.unexplained.length > 0 || errors.length > 0 ? 1 : 0);

async function main() {
  const { values: args } = parseArgs({ options: { dir: { type: "string", default: CLONES } } });
  const ci = !!process.env.GITHUB_ACTIONS;
  const rows = parseRows(readFileSync(resolve("test/golden/repos.tsv"), "utf8"), "repos.tsv");
  const records = (await loadRecords()).map((l) => l.record);
  const ids = new Set(records.flatMap(recordNames));
  const total: Tally = { mentions: 0, agreed: 0, explained: {}, unexplained: [] };
  const errors: string[] = [];
  for (const { repo, sha } of rows) {
    const dir = clone(args.dir, repo, sha);
    const run = dir ? runCheck(dir, repo) : { error: `could not fetch ${repo} at ${sha}` };
    if ("error" in run || run.report.scanned.records !== records.length) {
      errors.push("error" in run ? run.error : `darnit checked ${repo} against ${run.report.scanned.records} records, not all ${records.length}`);
      console.log(`${ci ? "::error::" : "error: "}${errors.at(-1)}`);
      continue;
    }
    const t = await answerKey(dir!, run.report, ids);
    console.log([`${repo}: ${summary(t)}`, ...misses(t).map((m) => `  unexplained ${m}`)].join("\n"));
    total.mentions += t.mentions;
    total.agreed += t.agreed;
    for (const [r, n] of Object.entries(t.explained) as [Rule, number][]) total.explained[r] = (total.explained[r] ?? 0) + n;
    total.unexplained.push(...t.unexplained.map((u) => ({ ...u, file: `${repo}/${u.file}` })));
  }
  const text = [`Total over ${rows.length - errors.length} of ${rows.length} repositories: ${summary(total)}`, ...errors.map((e) => `- ${e}`)].join("\n");
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n${misses(total).map((m) => `- ${m}`).join("\n")}\n`);
  process.exitCode = exitCode(total, errors);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
