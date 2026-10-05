import type { SgNode } from "@ast-grep/napi";

/**
 * How to tell a vendor's own client from a look-alike. `packages` and `hosts` are the vendor's;
 * `lookalikePackages` and `lookalikeHosts` are other providers that copy its methods. Only those
 * known look-alikes are ever called foreign: a wrapper, a local factory or an unfamiliar address
 * (often a proxy in front of the vendor) stays the vendor's, as it was before tracing existed.
 */
export type VendorClients = {
  packages: readonly string[];
  hosts: readonly string[];
  lookalikePackages: readonly string[];
  lookalikeHosts: readonly string[];
};

/**
 * Whether a call goes to the vendor. "foreign" means this file shows it goes to a known look-alike:
 * another provider's SDK, or the vendor's SDK pointed at that provider. Anything else is "vendor" or
 * "unknown", and both are treated as the vendor's.
 */
export type Origin = "vendor" | "foreign" | "unknown";

const hostOf = (url: string) => /^[a-z][a-z0-9+.-]*:\/\/([^/\s"'`:]+)/i.exec(url)?.[1]?.toLowerCase();
const onHost = (host: string, hosts: readonly string[]) => hosts.some((h) => host === h || host.endsWith(`.${h}`));

/** Origin of a written-out URL: foreign only for a known look-alike host. */
export function urlOrigin(url: string, v: VendorClients): Origin {
  const host = hostOf(url);
  if (!host) return "unknown";
  if (onHost(host, v.hosts)) return "vendor";
  return onHost(host, v.lookalikeHosts) ? "foreign" : "unknown";
}

/** "openai/resources" → "openai", "@scope/pkg/x" → "@scope/pkg", "cerebras.cloud.sdk" → "cerebras". */
const rootPackage = (pkg: string) => (pkg.startsWith("@") ? pkg.split("/").slice(0, 2).join("/") : pkg.split(/[/.]/)[0]!);

/** Local name → package it was imported from, for JavaScript/TypeScript and Python. */
function importsOf(source: string): Map<string, string> {
  const names = new Map<string, string>();
  const add = (name: string, pkg: string) => {
    if (name.trim()) names.set(name.trim(), pkg);
  };
  for (const m of source.matchAll(/import\s+([^;'"]+?)\s+from\s+["']([^"']+)["']/g)) {
    const [clause, pkg] = [m[1]!.replace(/^type\s+/, ""), m[2]!];
    const ns = /\*\s+as\s+([\w$]+)/.exec(clause);
    if (ns) add(ns[1]!, pkg);
    const def = /^\s*([\w$]+)/.exec(clause);
    if (def && !/^\s*[{*]/.test(clause)) add(def[1]!, pkg);
    for (const part of /\{([^}]*)\}/.exec(clause)?.[1]?.split(",") ?? []) {
      const alias = /^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?/.exec(part.trim());
      if (alias) add(alias[2] ?? alias[1]!, pkg);
    }
  }
  for (const m of source.matchAll(/(?:const|let|var)\s+([^=;]+?)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g)) {
    const [target, pkg] = [m[1]!.trim(), m[2]!];
    const destructured = /^\{([^}]*)\}$/.exec(target);
    if (!destructured) add(target, pkg);
    for (const part of destructured?.[1]!.split(",") ?? []) {
      const alias = /([\w$]+)\s*(?::\s*([\w$]+))?/.exec(part.trim());
      if (alias) add(alias[2] ?? alias[1]!, pkg);
    }
  }
  // Python: `from pkg import A, B as C`, including the parenthesised multi-line form.
  for (const m of source.matchAll(/^\s*from\s+([\w.]+)\s+import\s+(?:\(([^)]*)\)|([^\n]+))/gm)) {
    for (const part of (m[2] ?? m[3]!).split(",")) {
      const alias = /^([\w]+)(?:\s+as\s+([\w]+))?/.exec(part.replace(/#.*$/, "").trim());
      if (alias) add(alias[2] ?? alias[1]!, m[1]!);
    }
  }
  // Python: `import a, b.c as d`.
  for (const m of source.matchAll(/^\s*import\s+([\w.,\s]+?)\s*$/gm)) {
    for (const part of m[1]!.split(",")) {
      const alias = /^([\w.]+)(?:\s+as\s+(\w+))?$/.exec(part.trim());
      if (alias) add(alias[2] ?? alias[1]!.split(".")[0]!, alias[1]!);
    }
  }
  return names;
}

// Kind names differ per grammar (TypeScript has public_field_definition, JavaScript field_definition,
// Python assignment), so the tree is walked once and compared by name.
const ASSIGNMENTS = new Set(["variable_declarator", "assignment_expression", "public_field_definition", "field_definition", "assignment"]);
const FIELDS = new Set(["public_field_definition", "field_definition"]);
const FUNCTIONS = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
  "generator_function_declaration",
  "function_definition",
  "lambda",
]);
const CLASSES = new Set(["class_declaration", "class", "class_definition"]);

type Assignment = { target: string; value: SgNode; node: SgNode; field: boolean };
type FileIndex = { imports: Map<string, string>; assignments: Assignment[] };

// One walk and one import scan per parsed file, however many calls it has.
const indexes = new WeakMap<SgNode, FileIndex>();

function indexOf(root: SgNode): FileIndex {
  let index = indexes.get(root);
  if (index) return index;
  const assignments: Assignment[] = [];
  const walk = (node: SgNode) => {
    if (ASSIGNMENTS.has(String(node.kind()))) {
      const target = (node.field("name") ?? node.field("left") ?? node.field("property"))?.text();
      const value = node.field("value") ?? node.field("right");
      if (target && value) assignments.push({ target, value, node, field: FIELDS.has(String(node.kind())) });
    }
    for (const child of node.children()) walk(child);
  };
  walk(root);
  index = { imports: importsOf(root.text()), assignments };
  indexes.set(root, index);
  return index;
}

const contains = (outer: SgNode, inner: SgNode) => {
  const [o, i] = [outer.range(), inner.range()];
  return o.start.index <= i.start.index && i.end.index <= o.end.index;
};

/** The innermost function or class around `node`, or undefined at module level. */
const scopeOf = (node: SgNode, kinds: Set<string>) => node.ancestors().find((a) => kinds.has(String(a.kind())));

const SCOPES = new Set([...FUNCTIONS, ...CLASSES]);

/**
 * The value last assigned to `target` that the call can actually see: a bare name only from its
 * own scope or an enclosing one; `this.x` / `self.x` only from the same class.
 */
function assignedValue(index: FileIndex, target: string, call: SgNode): SgNode | undefined {
  const member = /^(?:this|self)\.([\w$]+)$/.exec(target)?.[1];
  const callClass = scopeOf(call, CLASSES);
  let found: Assignment | undefined;
  for (const a of index.assignments) {
    if (member !== undefined) {
      if (a.target !== target && !(a.field && a.target === member)) continue;
      const cls = scopeOf(a.node, CLASSES);
      if (!cls || !callClass || !contains(cls, call)) continue;
    } else {
      if (a.field || a.target !== target) continue;
      const scope = scopeOf(a.node, SCOPES);
      if (scope && !contains(scope, call)) continue;
    }
    // Nearest assignment above the call wins; one below only counts if nothing is above.
    const above = a.node.range().start.index <= call.range().start.index;
    const foundAbove = found !== undefined && found.node.range().start.index <= call.range().start.index;
    if (above || !foundAbove) found = a;
  }
  return found?.value;
}

/** The written-out base address in a constructor's arguments, following one same-file constant. */
function baseAddress(args: string, index: FileIndex, call: SgNode): string | undefined {
  const literal = /(?:baseURL|base_url)\s*[:=]\s*[fFrRbBuU]*(["'`])([^"'`]+)\1/.exec(args);
  if (literal) return literal[2];
  const named = /(?:baseURL|base_url)\s*[:=]\s*([\w$]+)\b/.exec(args)?.[1] ?? (/[{,]\s*baseURL\s*[,}]/.test(args) ? "baseURL" : undefined);
  const value = named && assignedValue(index, named, call);
  return value ? /^[fFrRbBuU]*(["'`])([^"'`]+)\1$/.exec(value.text())?.[2] : undefined;
}

/** Origin of a client built by calling `ctor` with `args`. */
function constructed(ctor: string, args: string, isNew: boolean, index: FileIndex, call: SgNode, v: VendorClients): Origin {
  const pkg = index.imports.get(ctor.split(".")[0]!);
  if (pkg === undefined) return "unknown";
  const root = rootPackage(pkg);
  if (v.lookalikePackages.includes(root)) return "foreign";
  // A wrapper or factory from any other package (wrapOpenAI, instructor, a local helper) is the
  // vendor's client underneath as far as this file can tell.
  if (!v.packages.includes(root)) return "unknown";
  const base = baseAddress(args, index, call);
  return base ? urlOrigin(base, v) : isNew || /^[A-Z]/.test(ctor.split(".").pop()!) ? "vendor" : "unknown";
}

/** A client construction: `new C(args)` or `C(args)`. */
function construction(node: SgNode): { ctor: string; args: string; isNew: boolean } | undefined {
  if (node.is("new_expression")) {
    const ctor = node.field("constructor")?.text();
    return ctor ? { ctor, args: node.field("arguments")?.text() ?? "", isNew: true } : undefined;
  }
  if (node.is("call_expression") || node.is("call")) {
    const ctor = node.field("function")?.text();
    return ctor && /^[\w$.]+$/.test(ctor) ? { ctor, args: node.field("arguments")?.text() ?? "", isNew: false } : undefined;
  }
  return undefined;
}

/**
 * Where the client behind an SDK call comes from, judged from this file alone. `callee` is the
 * call's function text (e.g. `client.beta.chat.completions.parse`), `symbol` the vendor method it
 * matched (`chat.completions.parse`) and `call` the call node itself.
 */
export function clientOrigin(root: SgNode, call: SgNode, callee: string, symbol: string, v: VendorClients): Origin {
  const base = callee
    .slice(0, callee.length - symbol.length)
    .replace(/\.$/, "")
    .replace(/\.beta$/, "")
    .trim();
  if (!base) return "unknown";
  const index = indexOf(root);
  const inline = /^(new\s+)?([\w$.]+)\s*\(([\s\S]*)\)$/.exec(base);
  if (inline) return constructed(inline[2]!, inline[3]!, Boolean(inline[1]), index, call, v);
  if (!/^(?:(?:this|self)\.)?[\w$]+$/.test(base)) return "unknown";
  const value = assignedValue(index, base, call);
  const built = value && construction(value);
  return built ? constructed(built.ctor, built.args, built.isNew, index, call, v) : "unknown";
}
