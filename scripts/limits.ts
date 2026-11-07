import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";

// The size and shape limits ARCHITECTURE.md sets for src/, run through eslint's linter with the rules below and
// nothing else: no config file is read, so none can widen them, and comments that turn a rule off are ignored.

const LIMITS = {
  "max-lines": ["error", { max: 300 }],
  "max-lines-per-function": ["error", { max: 50 }],
  complexity: ["error", { max: 10 }],
  "max-depth": ["error", { max: 3 }],
  "max-params": ["error", { max: 4 }],
  "no-nested-ternary": "error",
  "@typescript-eslint/no-shadow": "error",
} satisfies Linter.RulesRecord;

const CODE = /\.[cm]?[jt]sx?$/;
const CONFIG: Linter.Config[] = [
  // eslint leaves out node_modules folders unless told otherwise; one under src/ is still code in src/.
  { ignores: ["!**/node_modules/"] },
  {
    files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    languageOptions: { parser: tseslint.parser, sourceType: "module" },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: LIMITS,
  },
];

type Breach = { file: string; rule: string; line: number; column: number; message: string };

/** What a message names: the function as eslint calls it (`Function 'run'`, `Arrow function`), or the shadowed name. */
export function named(message: string) {
  return /^(.+?) has (?:a complexity|too many)/.exec(message)?.[1] ?? /^('[^']*') is already/.exec(message)?.[1] ?? "-";
}

/**
 * Each breach keyed by its file, rule, what it names and its place among the breaches of the same three (`#1`, `#2`),
 * so an edit elsewhere in the file keeps the key. The note gives the line and eslint's message.
 */
export function limitFindings(breaches: readonly Breach[]): ReadonlyMap<string, string> {
  const sorted = [...breaches].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule),
  );
  const count = new Map<string, number>();
  const found = new Map<string, string>();
  for (const b of sorted) {
    const key = `${b.file}\t${b.rule}\t${named(b.message)}`;
    const n = (count.get(key) ?? 0) + 1;
    count.set(key, n);
    found.set(`${key}\t#${n}`, `line ${b.line}: ${b.message}`);
  }
  return found;
}

/** Every code file under `root`'s src/, as a path from `root`; a linked file counts as the file it points to. */
function sources(root: string) {
  const src = join(root, "src");
  return readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((p) => CODE.test(p) && statSync(join(src, p)).isFile())
    .map((p) => relative(root, join(src, p)))
    .sort();
}

/** What breaks a limit in `root`'s src/. A file eslint cannot parse stops the check rather than passing. */
export function limits(root: string): ReadonlyMap<string, string> {
  const at = realpathSync(root);
  const linter = new Linter({ cwd: at });
  const breaches = sources(at).flatMap((file) =>
    linter
      .verify(readFileSync(join(at, file), "utf8"), CONFIG, { filename: file, allowInlineConfig: false })
      .map((m) => {
        if (!m.ruleId) throw new Error(`eslint could not check ${file}:${m.line}: ${m.message}`);
        return { file, rule: m.ruleId, line: m.line, column: m.column, message: m.message };
      }),
  );
  return limitFindings(breaches);
}
