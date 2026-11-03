import { existsSync, readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import ts from "typescript";

// The import graph of src/ and scripts/, read from each file's syntax tree, for the module map test.

export type Sources = Map<string, string>;
export type Graph = Map<string, Set<string>>;
/** The graph, and each import() or require() of a computed path as "file -> call". */
export type ImportGraph = { graph: Graph; computed: string[] };

const CODE = /\.[cm]?[jt]sx?$/;

/** Every file under src/ and every code file under scripts/, by path from the repository root. */
export function readSources(): Sources {
  const sources: Sources = new Map();
  for (const dir of ["src", "scripts"]) {
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      const file = posix.relative(".", `${entry.parentPath}/${entry.name}`.split("\\").join("/"));
      if (!entry.isDirectory() && (dir === "src" || CODE.test(file))) sources.set(file, readFileSync(file, "utf8"));
    }
  }
  return sources;
}

/** The source files TypeScript reads a JavaScript extension as, in the order it tries them. */
const SOURCE_FOR: [RegExp, string[]][] = [
  [/\.js$/, [".ts", ".tsx"]],
  [/\.jsx$/, [".tsx"]],
  [/\.mjs$/, [".mts"]],
  [/\.cjs$/, [".cts"]],
];

/** The file an import specifier names, with .js read as .ts or .tsx; undefined for a package or a builtin. */
function resolveSpecifier(file: string, specifier: string, sources: Sources): string | undefined {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return undefined;
  const path = posix.join(posix.dirname(file), specifier);
  const [ext, exts] = SOURCE_FOR.find(([e]) => e.test(path)) ?? [/$/, []];
  return [...exts.map((to) => path.replace(ext, to)), path].find((p) => sources.has(p)) ?? path;
}

const isCreateRequire = (node: ts.Node | undefined): boolean =>
  node !== undefined && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createRequire";

/** The path node of an import or export declaration, `import x = require()`, `declare module` or an import() type. */
function declaredPath(node: ts.Node): ts.Node | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) return node.moduleReference.expression;
  if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) return node.name;
  if (ts.isImportTypeNode(node)) return ts.isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument;
  return undefined;
}

/** The argument of import(), require(), a createRequire alias or createRequire(...)(), or the call when it has none. */
function loadedPath(node: ts.Node, loaders: Set<string>): ts.Node | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  const loads = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && loaders.has(callee.text)) || isCreateRequire(callee);
  return loads ? (node.arguments[0] ?? node) : undefined;
}

/** Every node of a file's syntax tree, and the names that load a module: require and createRequire aliases. */
function parse(file: string, text: string): { source: ts.SourceFile; nodes: ts.Node[]; loaders: Set<string> } {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const nodes: ts.Node[] = [];
  const walk = (node: ts.Node): void => {
    nodes.push(node);
    ts.forEachChild(node, walk);
  };
  walk(source);
  const loaders = new Set(["require"]);
  for (const node of nodes) if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isCreateRequire(node.initializer)) loaders.add(node.name.text);
  return { source, nodes, loaders };
}

type Imports = { paths: string[]; computed: string[] };
const parsed = new Map<string, Imports>();

/** The module paths a file names, and the calls that load a computed one. Comments and regex literals name none. */
export function importsOf(file: string, text: string): Imports {
  const key = `${file}\0${text}`;
  if (!parsed.has(key)) parsed.set(key, readImports(file, text));
  return parsed.get(key)!;
}

function readImports(file: string, text: string): Imports {
  const { source, nodes, loaders } = parse(file, text);
  const paths = source.referencedFiles.map((r) => (r.fileName.startsWith(".") ? r.fileName : `./${r.fileName}`));
  const computed: string[] = [];
  for (const node of nodes) {
    const path = declaredPath(node) ?? loadedPath(node, loaders);
    if (path && (ts.isStringLiteral(path) || ts.isNoSubstitutionTemplateLiteral(path))) paths.push(path.text);
    else if (path) computed.push(node.getText(source).replace(/\s+/g, ""));
  }
  return { paths, computed };
}

/** Each file's imports of other files under src/ and scripts/. A JSON file outside them is data, not a module. */
export function buildGraph(sources: Sources, problems: string[]): ImportGraph {
  const graph: Graph = new Map();
  const computed: string[] = [];
  for (const [file, text] of sources) {
    const targets = new Set<string>();
    graph.set(file, targets);
    if (!CODE.test(file)) continue;
    const found = importsOf(file, text);
    computed.push(...found.computed.map((call) => `${file} -> ${call}`));
    for (const specifier of found.paths) {
      const target = resolveSpecifier(file, specifier, sources);
      if (target === undefined || (target.endsWith(".json") && existsSync(target))) continue;
      if (sources.has(target)) targets.add(target);
      else problems.push(`${file} imports "${specifier}", which is not a file under src/ or scripts/`);
    }
  }
  return { graph, computed };
}

/** The strongly connected sets of files with more than one file or an import of itself (Tarjan). */
export function cycles(graph: Graph): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const found: string[][] = [];
  const visit = (file: string): void => {
    index.set(file, index.size);
    low.set(file, index.get(file)!);
    stack.push(file);
    for (const next of graph.get(file) ?? []) {
      if (!index.has(next)) visit(next);
      if (stack.includes(next)) low.set(file, Math.min(low.get(file)!, low.get(next)!));
    }
    if (low.get(file) !== index.get(file)) return;
    const set = stack.splice(stack.indexOf(file));
    if (set.length > 1 || graph.get(file)?.has(file)) found.push(set.sort());
  };
  for (const file of [...graph.keys()].sort()) if (!index.has(file)) visit(file);
  return found;
}
