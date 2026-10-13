export type Mention = { line: number; model: string };

/** Runs of name characters; a single character class, so it cannot backtrack. */
const WORD = /[\w.-]+/g;
const ALNUM = /[A-Za-z0-9]/;

/** Binary files hold a NUL byte near the start; text files do not. */
export const isBinary = (text: string) => text.slice(0, 8192).includes("\0");

/**
 * Every exact mention of `names` in `text`, once per name per line. A name counts only when it is
 * not part of a longer name: gpt-4 never matches gpt-4o, gpt-4.1, gpt-4-turbo or my_gpt-4, but a
 * sentence ending "gpt-4." does. Names are made of the same characters as WORD.
 */
export function findMentions(text: string, names: ReadonlySet<string>): Mention[] {
  const longest = Math.max(0, ...[...names].map((n) => n.length));
  const out: Mention[] = [];
  // Names already found on the current line.
  let seen = new Set<string>();
  let line = 1;
  let newline = text.indexOf("\n");
  for (const { 0: run, index } of text.matchAll(WORD)) {
    let model = run.length <= longest && names.has(run) ? run : undefined;
    // A "." not followed by a letter or digit ends a name, as at the end of a sentence.
    for (let i = run.indexOf("."); model === undefined && i !== -1 && i <= longest; i = run.indexOf(".", i + 1)) {
      if (!ALNUM.test(run[i + 1] ?? "") && names.has(run.slice(0, i))) model = run.slice(0, i);
    }
    if (model === undefined) continue;
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
