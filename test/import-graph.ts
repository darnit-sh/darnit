import { existsSync, readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import ts from "typescript";

// The import graph of src/ and scripts/, read from each file's syntax tree, for the module map test.

export type Sources = Map<string, string>;
export type Graph = Map<string, Set<string>>;
/**
 * The graph, each import() or require() of a computed path, and each other use of require or createRequire,
 * as "file<TAB>call", numbered from the second copy.
 */
export type ImportGraph = { graph: Graph; computed: string[]; loaders: string[] };

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

/** The names that load a module outside import syntax. */
const LOADERS = new Set(["require", "createRequire"]);

const isLiteral = (node: ts.Node | undefined): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));

/** The path node of an import or export declaration, `import x = require()`, `declare module` or an import() type. */
function declaredPath(node: ts.Node): ts.Node | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) return node.moduleReference.expression;
  if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) return node.name;
  if (ts.isImportTypeNode(node)) return ts.isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument;
  return undefined;
}

/** The argument of import(), or the call when it has none. */
function importedPath(node: ts.Node): ts.Node | undefined {
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? (node.arguments[0] ?? node) : undefined;
}

/** The call that loads a module through this name directly, with one argument: require(path) or createRequire(url)(path). */
function directCall(name: ts.Node): ts.CallExpression | undefined {
  const call = name.parent;
  if (!ts.isIdentifier(name) || !ts.isCallExpression(call) || call.expression !== name) return undefined;
  const loading = name.text === "require" ? call : call.parent;
  return ts.isCallExpression(loading) && (loading === call || loading.expression === call) && loading.arguments.length === 1 ? loading : undefined;
}

/** `import { createRequire }`, which only names the function a direct createRequire(url)(path) calls. */
const plainImport = (node: ts.Node): boolean =>
  ts.isIdentifier(node) && node.text === "createRequire" && ts.isImportSpecifier(node.parent) && node.parent.propertyName === undefined;

/** Declarations whose name is a key or a member, which only shares a loader's name. */
const MEMBERS = [ts.isPropertyAssignment, ts.isPropertySignature, ts.isPropertyDeclaration, ts.isMethodDeclaration, ts.isMethodSignature, ts.isGetAccessor, ts.isSetAccessor, ts.isEnumMember];
/** Objects whose require property is Node's own. */
const NODE_OBJECTS = new Set(["module", "global", "globalThis"]);

/** A string names a loader as an import, export or destructured name, or as an element access key. */
function stringUse(node: ts.StringLiteral): boolean {
  const up = node.parent;
  return ts.isImportSpecifier(up) || ts.isExportSpecifier(up) || (ts.isBindingElement(up) && up.propertyName === node) || (ts.isElementAccessExpression(up) && up.argumentExpression === node);
}

/** A property named require is Node's when called or read from Node's own objects; createRequire always is. */
function propertyUse(name: ts.Identifier, access: ts.PropertyAccessExpression): boolean {
  const called = ts.isCallExpression(access.parent) && access.parent.expression === access;
  return name.text === "createRequire" || called || (ts.isIdentifier(access.expression) && NODE_OBJECTS.has(access.expression.text));
}

/** Whether a node named require or createRequire uses the loader, as a value, rather than only sharing its name. */
function usesLoader(node: ts.Node): boolean {
  if (ts.isStringLiteral(node)) return stringUse(node);
  if (!ts.isIdentifier(node) || plainImport(node) || MEMBERS.some((is) => is(node.parent) && node.parent.name === node)) return false;
  for (let at = node.parent; !ts.isSourceFile(at); at = at.parent) if (ts.isTypeNode(at)) return false;
  const up = node.parent;
  return ts.isPropertyAccessExpression(up) && up.name === node ? propertyUse(node, up) : true;
}

/** Where a name is used: the call or property access it heads, or else the node that holds it. */
function useSite(name: ts.Node): ts.Node {
  let site = name;
  const heads = (up: ts.Node) => ts.isPropertyAccessExpression(up) || ts.isElementAccessExpression(up) || ts.isParenthesizedExpression(up) || (ts.isCallExpression(up) && up.expression === site);
  while (heads(site.parent)) site = site.parent;
  return site === name ? name.parent : site;
}

/** Every node of a file's syntax tree. */
function parse(file: string, text: string): { source: ts.SourceFile; nodes: ts.Node[] } {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const nodes: ts.Node[] = [];
  const walk = (node: ts.Node): void => {
    nodes.push(node);
    ts.forEachChild(node, walk);
  };
  walk(source);
  return { source, nodes };
}

/** A file's module paths, the calls that load a computed one, and each other use of require or createRequire. */
type Imports = { paths: string[]; computed: string[]; loaders: string[] };
const parsed = new Map<string, Imports>();

/** What a file imports, as code: comments, strings and regex literals that only mention an import add nothing. */
export function importsOf(file: string, text: string): Imports {
  const key = `${file}\0${text}`;
  if (!parsed.has(key)) parsed.set(key, readImports(file, text));
  return parsed.get(key)!;
}

function readImports(file: string, text: string): Imports {
  const { source, nodes } = parse(file, text);
  const flat = (node: ts.Node) => node.getText(source).replace(/\s+/g, "");
  const paths = source.referencedFiles.map((r) => (r.fileName.startsWith(".") ? r.fileName : `./${r.fileName}`));
  const found: Imports = { paths, computed: [], loaders: [] };
  for (const node of nodes) {
    const path = declaredPath(node) ?? importedPath(node);
    if (isLiteral(path)) paths.push(path.text);
    else if (path) found.computed.push(flat(node));
    if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && LOADERS.has(node.text) && usesLoader(node)) readLoader(node, found, flat);
  }
  return found;
}

/** A use of require or createRequire: a direct call adds its path, or its computed call; any other use is reported. */
function readLoader(name: ts.Node, found: Imports, flat: (node: ts.Node) => string): void {
  const call = directCall(name);
  const path = call?.arguments[0];
  if (isLiteral(path)) found.paths.push(path.text);
  else if (call) found.computed.push(flat(call));
  else found.loaders.push(flat(useSite(name)));
}

/** "file<TAB>call" for each call, a repeat numbered, so an allowlist line covers one call and not every copy of it. */
function numbered(file: string, calls: string[]): string[] {
  const seen = new Map<string, number>();
  return calls.map((call) => {
    const n = (seen.get(call) ?? 0) + 1;
    seen.set(call, n);
    return `${file}\t${call}${n > 1 ? `#${n}` : ""}`;
  });
}

/** Each file's imports of other files under src/ and scripts/. A JSON file outside them is data, not a module. */
export function buildGraph(sources: Sources, problems: string[]): ImportGraph {
  const graph: Graph = new Map();
  const computed: string[] = [];
  const loaders: string[] = [];
  for (const [file, text] of sources) {
    const targets = new Set<string>();
    graph.set(file, targets);
    if (!CODE.test(file)) continue;
    const found = importsOf(file, text);
    computed.push(...numbered(file, found.computed));
    loaders.push(...numbered(file, found.loaders));
    for (const specifier of found.paths) {
      const target = resolveSpecifier(file, specifier, sources);
      if (target === undefined || (target.endsWith(".json") && existsSync(target))) continue;
      if (sources.has(target)) targets.add(target);
      else problems.push(`${file} imports "${specifier}", which is not a file under src/ or scripts/`);
    }
  }
  return { graph, computed, loaders };
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
