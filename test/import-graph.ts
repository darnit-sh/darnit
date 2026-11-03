import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import ts from "typescript";

// The import graph of src/ and scripts/, read from the source text, for the module map test.

export type Sources = Map<string, string>;
export type Graph = Map<string, Set<string>>;

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

/** The file an import specifier names, with .js read as .ts; undefined for a package or a builtin. */
function resolveSpecifier(file: string, specifier: string, sources: Sources): string | undefined {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return undefined;
  const path = posix.join(posix.dirname(file), specifier);
  const asTs = path.replace(/\.([cm]?)js(x?)$/, ".$1ts$2");
  return sources.has(asTs) ? asTs : path;
}

/** Static imports, `import type`, `export ... from`, side effect imports and import() with a literal. */
export function buildGraph(sources: Sources, problems: string[]): Graph {
  const graph: Graph = new Map();
  for (const [file, text] of sources) {
    const targets = new Set<string>();
    graph.set(file, targets);
    if (!CODE.test(file)) continue;
    if (/\bimport\s*\(\s*(?:[^\s"'`)]|`[^`]*\$\{)/.test(text)) problems.push(`${file} has an import() of a computed path, which this test cannot place`);
    for (const { fileName } of ts.preProcessFile(text, true, true).importedFiles) {
      const target = resolveSpecifier(file, fileName, sources);
      if (target === undefined) continue;
      if (sources.has(target)) targets.add(target);
      else problems.push(`${file} imports "${fileName}", which is not a file under src/ or scripts/`);
    }
  }
  return graph;
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
