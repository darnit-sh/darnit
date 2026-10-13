import { NAMED } from "./values.js";

export type Mention = { line: number; model: string };

/** Runs of name characters, with letters, accent marks and digits in any script; a single character class, so it cannot backtrack. */
const WORD = /[\p{L}\p{M}\p{N}_.-]+/gu;
/** A letter or digit at the start; two code units cover letters outside the basic plane. */
const ALNUM = /^[\p{L}\p{M}\p{N}]/u;
const LETTERS = /^\p{L}+$/u;
const QUOTES = new Set(['"', "'", "`"]);
const SETTING = /^[ \t]*[=:][ \t]*$/;
const LINE_END = /[ \t]*\r?(?:\n|$)/y;

/** Binary files hold a NUL byte near the start; text files do not. */
export const isBinary = (text: string) => text.slice(0, 8192).includes("\0");

/** Whether a letter-only name at start..end sits inside quotes, plain or escaped as in a JSON string, or is the whole value of a model or engine setting named by `key`. */
function standsOut(text: string, start: number, end: number, key: string, keyEnd: number): boolean {
  const quote = text.charAt(start - 1);
  if (QUOTES.has(quote)) return text.charAt(start - 2) === "\\" ? text.startsWith(`\\${quote}`, end) : text.charAt(end) === quote;
  LINE_END.lastIndex = end;
  return NAMED.test(key) && SETTING.test(text.slice(keyEnd, start)) && LINE_END.test(text);
}

/**
 * Every exact mention of `names` in `text`, once per name per line. A name counts only when it is
 * not part of a longer name: gpt-4 never matches gpt-4o, gpt-4.1, gpt-4-turbo or my_gpt-4, but a
 * sentence ending "gpt-4." does. A letter in any script joins a word, so ada never matches orçada.
 * A name made only of letters, such as ada, is also an everyday word or name, so it counts only
 * directly inside quotes ("ada", 'ada', `ada` or \"ada\") or as a whole setting value (model: ada).
 */
export function findMentions(text: string, names: ReadonlySet<string>): Mention[] {
  const longest = Math.max(0, ...[...names].map((n) => n.length));
  const out: Mention[] = [];
  // Names already found on the current line.
  let seen = new Set<string>();
  let line = 1;
  let newline = text.indexOf("\n");
  // The run before, which names the setting when this run is its value.
  let key = "";
  let keyEnd = 0;
  for (const { 0: run, index } of text.matchAll(WORD)) {
    const setting = key;
    const settingEnd = keyEnd;
    key = run;
    keyEnd = index + run.length;
    let model = run.length <= longest && names.has(run) ? run : undefined;
    // A "." not followed by a letter or digit ends a name, as at the end of a sentence.
    for (let i = run.indexOf("."); model === undefined && i !== -1 && i <= longest; i = run.indexOf(".", i + 1)) {
      if (!ALNUM.test(run.slice(i + 1, i + 3)) && names.has(run.slice(0, i))) model = run.slice(0, i);
    }
    if (model === undefined) continue;
    if (LETTERS.test(model) && !standsOut(text, index, index + model.length, setting, settingEnd)) continue;
    if (newline !== -1 && newline < index) seen = new Set();
    while (newline !== -1 && newline < index) {
      line++;
      newline = text.indexOf("\n", newline + 1);
    }
    if (seen.has(model)) continue;
    seen.add(model);
    out.push({ line, model });
  }
  return out;
}
