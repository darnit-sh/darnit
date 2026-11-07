import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { Linter, SourceCode } from "eslint";

// The size and shape limits ARCHITECTURE.md sets for src/, run through eslint's linter with the rules below and
// nothing else: no config file is read, so none can widen them, and comments that turn a rule off are ignored.
// eslint and its TypeScript parser load from the checked repository's own node_modules, so a folder of the same name
// committed beside this script cannot stand in for them.

const LIMITS = {
  "max-lines": ["error", { max: 300 }],
  "max-lines-per-function": ["error", { max: 50, IIFEs: true }],
  complexity: ["error", { max: 10 }],
  "max-depth": ["error", { max: 3 }],
  "max-params": ["error", { max: 4 }],
  "no-nested-ternary": "error",
  "@typescript-eslint/no-shadow": "error",
} satisfies Linter.RulesRecord;

const CODE = /\.[cm]?[jt]sx?$/;
const FUNCTION = /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|StaticBlock)$/;
const KEYED = /^(MethodDefinition|TSAbstractMethodDefinition|Property|PropertyDefinition|AccessorProperty)$/;
// What can stand between a function and the name it is given: a cast, or the call of a function invoked at once.
const WRAPPER = /^(TSAsExpression|TSSatisfiesExpression|TSNonNullExpression|TSTypeAssertion|CallExpression)$/;

type Node = { type: string; parent?: Node; id?: Node | null; key?: Node; value?: unknown; name?: string } & {
  computed?: boolean;
  callee?: Node;
  left?: Node;
  property?: Node;
};
type Breach = { file: string; rule: string; name: string; line: number; column: number; message: string };
type Line = { line: number; finding: string };

/** The number eslint's message measures (lines, complexity, depth, parameters); 1 for a breach it does not measure. */
export function measured(message: string) {
  const m = /complexity of (\d+)|\((\d+)\)/.exec(message);
  return m ? Number(m[1] ?? m[2]) : 1;
}

/** A property key as written, unless it is computed. */
function keyName(key: Node | undefined, computed?: boolean) {
  if (!key || computed) return undefined;
  if (key.type === "PrivateIdentifier") return `#${key.name}`;
  return key.type === "Literal" ? String(key.value) : key.name;
}

/** The node a function's name is given on, past a cast or the call of a function invoked at once. */
function holder(fn: Node) {
  let child = fn;
  while (child.parent && WRAPPER.test(child.parent.type) && (child.parent.callee ?? child) === child)
    child = child.parent;
  return child.parent;
}

const GIVEN: Record<string, (p: Node) => string | undefined> = {
  VariableDeclarator: (p) => p.id?.name,
  ExportDefaultDeclaration: () => "default",
  AssignmentExpression: (p) => p.left?.name ?? keyName(p.left?.property, p.left?.computed),
};

/** The name a function is declared or assigned with, or its class's for a static block. */
function nameOf(fn: Node): string | undefined {
  if (fn.type === "StaticBlock") return fn.parent?.parent?.id?.name;
  if (fn.id?.name) return fn.id.name;
  const p = holder(fn);
  if (!p) return undefined;
  return KEYED.test(p.type) ? keyName(p.key, p.computed) : GIVEN[p.type]?.(p);
}

/** The function `node` sits in, counting a method's key as part of the method. */
function ownerOf(node: Node | undefined) {
  for (let n = node; n; n = n.parent) {
    if (FUNCTION.test(n.type)) return n;
    if (KEYED.test(n.type) && FUNCTION.test((n.value as Node | undefined)?.type ?? "")) return n.value as Node;
  }
  return undefined;
}

/** The nearest named function around the place eslint reports, or `(top)` at the top of the file. */
function owner(code: SourceCode, line: number, column: number) {
  const at = code.getNodeByRangeIndex(code.getIndexFromLoc({ line, column: column - 1 })) as Node | null;
  for (let fn = ownerOf(at ?? undefined); fn; fn = ownerOf(fn.parent)) {
    const name = nameOf(fn);
    if (name) return name;
  }
  return "(top)";
}

/**
 * Each breach keyed by its file, rule and name, a repeat of the same three numbered (`name #2`), so an edit elsewhere
 * keeps the key. A breach at or below the cap its listed line gives is found as that line; one above it is found
 * with its own measure, so the check names it. The note gives the line and eslint's message.
 */
export function limitFindings(breaches: readonly Breach[], lines: readonly Line[]): ReadonlyMap<string, string> {
  const listed = new Map(lines.map((l) => [l.finding.split("\t").slice(0, 3).join("\t"), l.finding]));
  const sorted = [...breaches].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule),
  );
  const count = new Map<string, number>();
  const found = new Map<string, string>();
  for (const b of sorted) {
    const base = `${b.file}\t${b.rule}\t${b.name}`;
    const n = (count.get(base) ?? 0) + 1;
    count.set(base, n);
    const key = n === 1 ? base : `${base} #${n}`;
    for (const [finding, note] of place(key, b, listed.get(key))) found.set(finding, note);
  }
  return found;
}

/** What a breach is found as, given the listed line of the same key, if any. */
function place(key: string, b: Breach, line: string | undefined): [string, string][] {
  const cap = line?.split("\t")[3] ?? "";
  const measure = measured(b.message);
  const note = `line ${b.line}: ${b.message}`;
  if (!line || !/^\d+$/.test(cap)) return [[`${key}\t${measure}`, note]];
  if (measure <= Number(cap)) return [[line, note]];
  // Its line stays found, so the breach is named once, as over its cap rather than as gone.
  return [
    [line, note],
    [`${key}\t${measure}`, `${note}; above the cap of ${cap} its line gives`],
  ];
}

/** Every code file under `root`'s src/, as a path from `root`; a linked file counts as the file it points to. */
function sources(root: string) {
  const src = join(root, "src");
  return readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((p) => {
      const at = join(src, p);
      if (lstatSync(at).isSymbolicLink() && statSync(at).isDirectory())
        throw new Error(`src/${p} links to a folder, which the limits check does not read; move the code into src/`);
      return CODE.test(p) && statSync(at).isFile();
    })
    .map((p) => join("src", p))
    .sort();
}

/** What breaks a limit in `root`'s src/, against the caps `lines` give. A file eslint cannot parse stops the check. */
export function limits(dir: string, lines: readonly Line[] = []): ReadonlyMap<string, string> {
  const root = resolve(dir);
  const pkg = join(root, "package.json");
  const eslint = createRequire(pkg)("eslint") as typeof import("eslint");
  const tseslint = createRequire(pkg)("typescript-eslint") as typeof import("typescript-eslint");
  const config: Linter.Config[] = [
    // eslint leaves out node_modules folders unless told otherwise; one under src/ is still code in src/.
    { ignores: ["!**/node_modules/"] },
    {
      files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
      languageOptions: { parser: tseslint.parser, sourceType: "module" },
      plugins: { "@typescript-eslint": tseslint.plugin },
      rules: LIMITS,
    },
  ];
  const linter = new eslint.Linter({ cwd: root });
  const breaches = sources(root).flatMap((file) => {
    const messages = linter.verify(readFileSync(join(root, file), "utf8"), config, {
      filename: file,
      allowInlineConfig: false,
    });
    const code = linter.getSourceCode();
    return messages.map((m) => {
      if (!m.ruleId) throw new Error(`eslint could not check ${file}:${m.line}: ${m.message}`);
      const name = m.ruleId === "max-lines" ? "(file)" : owner(code, m.line, m.column);
      return { file, rule: m.ruleId, name, line: m.line, column: m.column, message: m.message };
    });
  });
  return limitFindings(breaches, lines);
}
