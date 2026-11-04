import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

// Code knip cannot see is unused, named by `unseen` lines in scripts/allow/unused.tsv. A name counts as unused while
// its file declares it at top level, no other top-level declaration there uses it (one also listed and unused
// aside), and no other file imports it by name, destructures it from import(), or reads it from a namespace import
// of the file. Comments and the text of strings are left out first. Known limit: a use through a module object
// handed on some other way (returned from a function, spread into a mock) is not seen.

const SEARCHED = /^(src|scripts|test)\/.*\.ts$/;
const SKIPPED = /^test\/(samples|e2e|fixtures|golden)\//;
const DECLARATION = /^(?:export\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|type|interface|enum)\s+(\w+)/;

/** `text` without comments, and with the text of every string taken out unless `strings`. */
export function strip(text: string, strings = false): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, (m) => {
    if (m.startsWith("/")) return m.startsWith("/*") ? m.replace(/[^\n]/g, "") : "";
    return strings ? m : m[0]!.repeat(2);
  });
}

/** Each top-level declaration in `text`, by name, with the text up to the next one. */
export function declarations(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let name = "";
  for (const line of text.split("\n")) {
    name = DECLARATION.exec(line)?.[1] ?? name;
    if (name) out.set(name, `${out.get(name) ?? ""}${line}\n`);
  }
  return out;
}

/** Whether `body` uses `name`, not as a property or key, and declares no `name` of its own. */
export function uses(body: string, name: string): boolean {
  const unkeyed = body.replace(new RegExp(`(^|[{,])(\\s*)${name}(\\s*\\??:)`, "gm"), "$1$2_$3");
  if (!new RegExp(`(?<![\\w$.])${name}(?![\\w$])`).test(unkeyed)) return false;
  const own = new RegExp(`\\b(?:const|let|var|function)\\s+${name}\\b|\\b(?:const|let|var)\\s+[[{][^\\]}]*(?<![\\w$.])${name}\\b`);
  return !own.test(body.slice(body.indexOf("\n")));
}

function sources(root: string, dir = ""): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const path = posix.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || SKIPPED.test(`${path}/`) ? [] : sources(root, path);
    return SEARCHED.test(path) ? [path] : [];
  });
}

/** The repository path an import in `from` names, a .js name read as the .ts file beside it. */
const resolved = (from: string, spec: string) => posix.normalize(posix.join(posix.dirname(from), spec)).replace(/\.js$/, ".ts");

/** The names other files take from `file`: imported or destructured by name, or read from a namespace import. */
export function imported(root: string, file: string): Set<string> {
  const names = new Set<string>();
  const add = (list: string) => list.split(",").forEach((n) => names.add(n.trim().replace(/^type\s+/, "").split(/\s|:/)[0]!));
  for (const other of sources(root).filter((f) => f !== file)) {
    const text = strip(readFileSync(join(root, other), "utf8"), true);
    const from = (spec: string) => spec.startsWith(".") && resolved(other, spec) === file;
    for (const m of text.matchAll(/\{([^}]*)\}\s*(?:from\s*|=\s*await\s+import\(\s*)["']([^"']+)["']/g)) if (from(m[2]!)) add(m[1]!);
    for (const m of text.matchAll(/(?:\*\s+as|const|let|var)\s+(\w+)\s*(?:from\s*|=\s*await\s+import\(\s*)["']([^"']+)["']/g)) {
      if (!from(m[2]!)) continue;
      for (const use of strip(text).matchAll(new RegExp(`\\b${m[1]}\\s*\\.\\s*(\\w+)`, "g"))) names.add(use[1]!);
    }
  }
  return names;
}

/** Of `names` that `file` declares, those still unused, as the comment above says. */
export function stillUnused(root: string, file: string, names: readonly string[]): Set<string> {
  let text: string;
  try {
    text = strip(readFileSync(join(root, file), "utf8"));
  } catch {
    return new Set();
  }
  const top = declarations(text);
  const taken = imported(root, file);
  let left = new Set(names.filter((n) => /^\w+$/.test(n) && top.has(n) && !taken.has(n)));
  for (let size = -1; size !== left.size; ) {
    size = left.size;
    const users = [...top].filter(([owner]) => !left.has(owner));
    left = new Set([...left].filter((n) => !users.some(([, body]) => uses(body, n))));
  }
  return left;
}
