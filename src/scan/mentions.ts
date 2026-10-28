import { extname } from "node:path";
import { NAMED } from "./values.js";

export type Mention = { line: number; model: string };

/** Runs of name characters, with letters, accent marks and digits in any script; a single character class, so it cannot backtrack. */
const WORD = /[\p{L}\p{M}\p{N}_.-]+/gu;
/** A letter or digit at the start; two code units cover letters outside the basic plane. */
const ALNUM = /^[\p{L}\p{M}\p{N}]/u;
const LETTERS = /^\p{L}+$/u;
/** A name code could also use as a variable, such as o1. */
const IDENTIFIER = /^[\p{L}\p{M}\p{N}_]+$/u;
const QUOTES = new Set(['"', "'", "`"]);
const SETTING = /^[ \t]*[=:][ \t]*$/;
const LINE_END = /[ \t]*\r?(?:\n|$)/y;
const PROVIDER_VERSION = /@\d{8}(?!\d)/y;
/** Longer lines are minified or machine-made. */
const LONG_LINE = 5000;

/**
 * How a language writes comments and strings: `hash` comments, strings in `multiline` that may span lines,
 * `raw` when those have no escapes, and `apostrophe` when ' opens a string (in Rust it also marks a lifetime).
 */
type Syntax = { hash?: boolean; multiline: string[]; raw?: boolean; apostrophe: boolean };
const PYTHON: Syntax = { hash: true, multiline: ['"""', "'''"], apostrophe: true };
const family = (exts: string[], syntax: Syntax) => Object.fromEntries(exts.map((e) => [`.${e}`, syntax]));
const SYNTAX: Record<string, Syntax> = {
  ".py": PYTHON,
  ".pyi": PYTHON,
  ...family(["js", "mjs", "cjs", "ts", "mts", "cts"], { multiline: ["`"], apostrophe: true }),
  ...family(["go"], { multiline: ["`"], raw: true, apostrophe: true }),
  ...family(["kt", "kts", "scala"], { multiline: ['"""'], raw: true, apostrophe: true }),
  ...family(["java", "groovy", "swift", "dart"], { multiline: ['"""'], apostrophe: true }),
  ...family(["c", "h", "cc", "cpp", "cxx", "hpp", "cs"], { multiline: [], apostrophe: true }),
  ...family(["rs"], { multiline: [], apostrophe: false }),
};

/** Binary files hold a NUL byte near the start; text files do not. */
export const isBinary = (text: string) => text.slice(0, 8192).includes("\0");

/** Whether the name at start..end sits directly inside quotes, plain or escaped as in a JSON string. */
function quoted(text: string, start: number, end: number): boolean {
  const quote = text.charAt(start - 1);
  if (!QUOTES.has(quote)) return false;
  return text.charAt(start - 2) === "\\" ? text.startsWith(`\\${quote}`, end) : text.charAt(end) === quote;
}

/** Whether the name at start..end is the whole value of a model or engine setting named by `key`. */
function setting(text: string, start: number, end: number, key: string, keyEnd: number): boolean {
  LINE_END.lastIndex = end;
  return NAMED.test(key) && SETTING.test(text.slice(keyEnd, start)) && LINE_END.test(text);
}

/**
 * Whether each position, asked in increasing order, is inside a comment or string. One pass forward over the text, so a
 * crafted file costs linear time. An unclosed quote ends at the line end; an unclosed block comment runs to the end.
 */
function commentsAndStrings(text: string, { hash, multiline, raw, apostrophe }: Syntax): (at: number) => boolean {
  let i = 0;
  // What closes the comment or string at i, or "" in code.
  let close = "";
  // Whether a line end also closes it, as for a quote or a line comment.
  let oneLine = false;
  // Whether a backslash escapes the next character.
  let escapes = false;
  return (at) => {
    while (i < at) {
      const c = text[i]!;
      if (close === "") {
        const comment = hash ? (c === "#" ? "#" : undefined) : c === "/" && (text[i + 1] === "/" || text[i + 1] === "*") ? text.slice(i, i + 2) : undefined;
        const quote = comment ? undefined : (multiline.find((q) => text.startsWith(q, i)) ?? (c === '"' || (apostrophe && c === "'") ? c : undefined));
        if (comment || quote) {
          close = comment === "/*" ? "*/" : (quote ?? "\n");
          oneLine = close === "\n" || (quote !== undefined && !multiline.includes(close));
          escapes = quote !== undefined && !(raw && !oneLine);
        }
        i += (comment ?? quote ?? c).length;
      } else if (c === "\n" && oneLine) close = "";
      else if (text.startsWith(close, i)) {
        i += close.length;
        close = "";
      } else i += escapes && c === "\\" ? 2 : 1;
    }
    return close !== "";
  };
}

/**
 * Every exact mention of `names` in `text`, once per name per line. A name counts only when it is
 * not part of a longer name: gpt-4 never matches gpt-4o, gpt-4.1, gpt-4-turbo or my_gpt-4, but a
 * sentence ending "gpt-4." does. A name directly followed by @ and an eight-digit date is a cloud
 * provider's own versioned name, such as Google's claude-sonnet-4-5@20250929, retired on that
 * provider's dates, so it does not count; gpt-4@tool still does. A letter in any script joins a word, so ada never matches orçada.
 * A name made only of letters, such as ada, is also an everyday word or name, so it counts only
 * directly inside quotes ("ada", 'ada', `ada` or \"ada\") or as a whole setting value (model: ada).
 * A name code could use as a variable, such as o1, counts in code files (by `file`'s extension) only
 * inside a comment or string or as a setting value, and on a line over 5,000 characters only as a
 * letters-only name would.
 */
export function findMentions(text: string, names: ReadonlySet<string>, file = ""): Mention[] {
  const longest = Math.max(0, ...[...names].map((n) => n.length));
  const syntax = SYNTAX[extname(file)];
  let inside: ((at: number) => boolean) | undefined;
  const out: Mention[] = [];
  // Names already found on the current line.
  let seen = new Set<string>();
  let line = 1;
  let lineStart = 0;
  let newline = text.indexOf("\n");
  // The run before, which names the setting when this run is its value.
  let key = "";
  let keyEnd = 0;
  for (const { 0: run, index } of text.matchAll(WORD)) {
    const named = key;
    const namedEnd = keyEnd;
    key = run;
    keyEnd = index + run.length;
    let model = run.length <= longest && names.has(run) ? run : undefined;
    // A "." not followed by a letter or digit ends a name, as at the end of a sentence.
    for (let i = run.indexOf("."); model === undefined && i !== -1 && i <= longest; i = run.indexOf(".", i + 1)) {
      if (!ALNUM.test(run.slice(i + 1, i + 3)) && names.has(run.slice(0, i))) model = run.slice(0, i);
    }
    if (model === undefined) continue;
    if (newline !== -1 && newline < index) seen = new Set();
    while (newline !== -1 && newline < index) {
      line++;
      lineStart = newline + 1;
      newline = text.indexOf("\n", newline + 1);
    }
    const end = index + model.length;
    PROVIDER_VERSION.lastIndex = end;
    if (PROVIDER_VERSION.test(text)) continue;
    if (IDENTIFIER.test(model)) {
      const strict = LETTERS.test(model) || (newline === -1 ? text.length : newline) - lineStart > LONG_LINE;
      const value = setting(text, index, end, named, namedEnd);
      if (strict && !quoted(text, index, end) && !value) continue;
      if (!strict && syntax && !value && !(inside ??= commentsAndStrings(text, syntax))(index)) continue;
    }
    if (seen.has(model)) continue;
    seen.add(model);
    out.push({ line, model });
  }
  return out;
}
