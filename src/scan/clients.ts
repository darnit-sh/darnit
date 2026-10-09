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
 * Whether a call goes to the vendor. "foreign" means this file shows, without doubt, that it goes to
 * a known look-alike. Anything less certain is "vendor" or "unknown", and both count as the vendor's:
 * dropping a real call is worse than rewriting a look-alike's.
 */
export type Origin = "vendor" | "foreign" | "unknown" | { local: string[] };

const hostOf = (url: string) => /^[a-z][a-z0-9+.-]*:\/\/([^/\s"'`:]+)/i.exec(url)?.[1]?.toLowerCase();
const onHost = (host: string, hosts: readonly string[]) => hosts.some((h) => host === h || host.endsWith(`.${h}`));

// This machine, a container's host or a service name with no dot (docker compose), the local
// network, and private and link-local address ranges, in IPv4 and IPv6.
const LOCAL_HOST =
  /^(?:[a-z0-9_-]+|.+\.localhost|host\.docker\.internal|.+\.local|0\.0\.0\.0|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|\[::1\]|\[f[cd][0-9a-f]{0,2}:[0-9a-f:]*\]|\[fe[89ab][0-9a-f]:[0-9a-f:]*\])$/i;

/** "localhost:11434" for a URL whose host is local; undefined otherwise. */
function localAddress(url: string): string | undefined {
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/\s"'`?#]+)/i.exec(url)?.[1]?.split("@").pop();
  if (!authority) return undefined;
  const host = (authority.startsWith("[") ? authority.slice(0, authority.indexOf("]") + 1) : authority.split(":")[0]!).replace(/\.$/, "");
  // An IPv4 address written as IPv6, [::ffff:127.0.0.1], is judged as the IPv4 address.
  const mapped = /^\[::ffff:([\d.]+)\]$/i.exec(host)?.[1];
  return LOCAL_HOST.test(mapped ?? host) ? authority.toLowerCase() : undefined;
}

/** Origin of a written-out URL: foreign only for a known look-alike host, local for this machine or network. */
export function urlOrigin(url: string, v: VendorClients): Origin {
  const host = hostOf(url);
  if (!host) return "unknown";
  if (onHost(host, v.hosts)) return "vendor";
  if (onHost(host, v.lookalikeHosts)) return "foreign";
  const local = localAddress(url);
  return local ? { local: [local] } : "unknown";
}

/** The text of a string literal without prefix or quotes (`f"https://…"` → `https://…`). */
export const stringText = (node: SgNode): string | undefined =>
  node.is("string") || node.is("template_string") ? /^[fFrRbBuU]*(["'`]{1,3})([\s\S]*?)\1$/.exec(node.text())?.[2] : undefined;

/** "openai/resources" → "openai", "@scope/pkg/x" → "@scope/pkg", "cerebras.cloud.sdk" → "cerebras". */
const rootPackage = (pkg: string) => (pkg.startsWith("@") ? pkg.split("/").slice(0, 2).join("/") : pkg.split(/[/.]/)[0]!);

export const FUNCTIONS = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
  "generator_function_declaration",
  "generator_function",
  "function_definition",
  "lambda",
]);
const CLASSES = new Set(["class_declaration", "class", "class_definition"]);
const FIELDS = new Set(["public_field_definition", "field_definition"]);
const ASSIGNMENTS = new Set(["variable_declarator", "assignment_expression", "public_field_definition", "field_definition", "assignment"]);
const IMPORTS = new Set(["import_statement", "import_from_statement"]);

type Assignment = { target: string; value: SgNode; node: SgNode; field: boolean; blockScoped: boolean };
type FileIndex = { imports: Map<string, Set<string>>; assignments: Assignment[] };

/** Local name → every package it is imported from, read from import statements only (never comments or strings). */
function importsOf(statements: readonly string[]): Map<string, Set<string>> {
  const names = new Map<string, Set<string>>();
  const add = (name: string, pkg: string) => {
    if (!name.trim()) return;
    const set = names.get(name.trim()) ?? new Set<string>();
    set.add(pkg);
    names.set(name.trim(), set);
  };
  for (const text of statements) {
    for (const m of text.matchAll(/import\s+([^;'"]+?)\s+from\s+["']([^"']+)["']/g)) {
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
    for (const m of text.matchAll(/([^=;]+?)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g)) {
      const [target, pkg] = [m[1]!.replace(/^\s*(?:const|let|var|import)\s+/, "").trim(), m[2]!];
      const destructured = /^\{([^}]*)\}$/.exec(target);
      if (!destructured) add(target, pkg);
      for (const part of destructured?.[1]!.split(",") ?? []) {
        const alias = /([\w$]+)\s*(?::\s*([\w$]+))?/.exec(part.trim());
        if (alias) add(alias[2] ?? alias[1]!, pkg);
      }
    }
    for (const m of text.matchAll(/^\s*from\s+([\w.]+)\s+import\s+(?:\(([^)]*)\)|([^\n]+))/gm)) {
      for (const part of (m[2] ?? m[3]!).split(",")) {
        const alias = /^([\w]+)(?:\s+as\s+([\w]+))?/.exec(part.replace(/#.*$/, "").trim());
        if (alias) add(alias[2] ?? alias[1]!, m[1]!);
      }
    }
    for (const m of text.matchAll(/^\s*import\s+([\w.,\s]+?)\s*$/gm)) {
      for (const part of m[1]!.split(",")) {
        const alias = /^([\w.]+)(?:\s+as\s+(\w+))?$/.exec(part.trim());
        if (alias) add(alias[2] ?? alias[1]!.split(".")[0]!, alias[1]!);
      }
    }
  }
  return names;
}

const scopeKinds = (node: SgNode) => node.ancestors().find((a) => FUNCTIONS.has(String(a.kind())) || CLASSES.has(String(a.kind())));
const isClass = (node: SgNode | undefined) => node !== undefined && CLASSES.has(String(node.kind()));

// One iterative walk and one import read per parsed file, however many calls it has. Iterative so
// a deeply nested generated file can't overflow the stack.
const indexes = new WeakMap<SgNode, FileIndex>();

function indexOf(root: SgNode): FileIndex {
  let index = indexes.get(root);
  if (index) return index;
  const assignments: Assignment[] = [];
  const importTexts: string[] = [];
  const stack: SgNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const kind = String(node.kind());
    if (IMPORTS.has(kind)) importTexts.push(node.text());
    if (ASSIGNMENTS.has(kind)) {
      const target = (node.field("name") ?? node.field("left") ?? node.field("property"))?.text();
      const value = node.field("value") ?? node.field("right");
      if (target && value) {
        if ((value.is("call_expression") || value.is("member_expression")) && /^require\s*\(/.test(value.text())) importTexts.push(node.text());
        // A Python class-body assignment is a class attribute: reached as self.x, not as a bare name.
        const field = FIELDS.has(kind) || (kind === "assignment" && isClass(scopeKinds(node)));
        // let and const live in their block; var and plain assignments live in the whole function.
        const blockScoped = kind === "variable_declarator" && node.parent()?.is("lexical_declaration") === true;
        assignments.push({ target, value, node, field, blockScoped });
      }
    }
    for (const child of node.children()) stack.push(child);
  }
  index = { imports: importsOf(importTexts), assignments };
  indexes.set(root, index);
  return index;
}

const contains = (outer: SgNode, inner: SgNode) => {
  const [o, i] = [outer.range(), inner.range()];
  return o.start.index <= i.start.index && i.end.index <= o.end.index;
};

/** Parameter names of a function node (JavaScript, TypeScript or Python). */
function parameters(fn: SgNode): string[] {
  const list = fn.field("parameters") ?? fn.field("parameter");
  if (!list) return [];
  if (list.is("identifier")) return [list.text()];
  return list
    .children()
    .filter((c) => c.isNamed())
    .map((c) => (c.is("identifier") ? c.text() : (c.field("pattern") ?? c.field("name") ?? c.children().find((x) => x.is("identifier")))?.text()))
    .filter((n): n is string => Boolean(n));
}

/** True if a Python function declares `global name`, which makes its assignments module-level. */
const declaresGlobal = (fn: SgNode, name: string) => new RegExp(`(^|\\n)\\s*global\\s+[\\w\\s,]*\\b${name}\\b`).test(fn.text());

const blockOf = (a: Assignment) => a.node.ancestors().find((x) => x.is("statement_block") || FUNCTIONS.has(String(x.kind())));

/** Every assignment to `target` that could be the value the call sees. */
function visibleAssignments(index: FileIndex, target: string, call: SgNode): Assignment[] {
  const visible = reachingAssignments(index, target, call);
  // A let or const in an inner block hides one of the same name in a block around it.
  const blocks = visible.filter((a) => a.blockScoped).map(blockOf);
  return visible.filter((a) => {
    const block = a.blockScoped ? blockOf(a) : undefined;
    return !block || !blocks.some((b) => b && b.range().start.index !== block.range().start.index && contains(block, b));
  });
}

/** Assignments to `target` whose scope reaches the call, before any shadowing. */
function reachingAssignments(index: FileIndex, target: string, call: SgNode): Assignment[] {
  const member = /^(?:this|self)\.([\w$#]+)$/.exec(target)?.[1];
  const callClass = call.ancestors().find((a) => CLASSES.has(String(a.kind())));
  const callFunctions = call.ancestors().filter((a) => FUNCTIONS.has(String(a.kind())));
  return index.assignments.filter((a) => {
    // A placeholder such as `client = null` is not a client.
    if (/^(null|undefined|None)$/.test(a.value.text())) return false;
    if (member !== undefined) {
      if (a.target !== target && !(a.field && a.target === member)) return false;
      const cls = a.node.ancestors().find((x) => CLASSES.has(String(x.kind())));
      return cls !== undefined && callClass !== undefined && cls.range().start.index === callClass.range().start.index;
    }
    if (a.field || a.target !== target) return false;
    // A let or const is only visible inside the block that holds it.
    if (a.blockScoped) {
      const block = blockOf(a);
      if (block && !contains(block, call)) return false;
    }
    const scope = scopeKinds(a.node);
    if (scope && FUNCTIONS.has(String(scope.kind())) && !contains(scope, call) && !declaresGlobal(scope, target)) return false;
    // A parameter with the same name, between the assignment and the call, shadows it.
    return !callFunctions.some((fn) => !contains(fn, a.node) && parameters(fn).includes(target));
  });
}

/** The written-out base address in a constructor's arguments, read from the syntax so comments never count. */
function baseAddress(args: SgNode | null, index: FileIndex, call: SgNode): string | undefined {
  if (!args) return undefined;
  const stack: SgNode[] = [args];
  while (stack.length > 0) {
    const node = stack.pop()!;
    let value: SgNode | null | undefined;
    if (node.is("pair") && /^["']?baseURL["']?$/.test(node.field("key")?.text() ?? "")) value = node.field("value");
    else if (node.is("keyword_argument") && node.field("name")?.text() === "base_url") value = node.field("value");
    else if (node.is("shorthand_property_identifier") && node.text() === "baseURL") value = node;
    if (value) {
      const literal = stringText(value);
      if (literal !== undefined) return literal;
      if (value.is("identifier") || value.is("shorthand_property_identifier")) {
        const consts = visibleAssignments(index, value.text(), call).map((a) => stringText(a.value));
        return consts.length === 1 ? consts[0] : undefined;
      }
      return undefined;
    }
    // Don't descend into nested calls or functions: their options are not this client's.
    if (node === args || !(node.is("call_expression") || node.is("call") || node.is("new_expression") || FUNCTIONS.has(String(node.kind())))) {
      for (const child of node.children()) stack.push(child);
    }
  }
  return undefined;
}

/** Origin of a client built as `new C(args)` or `C(args)`. */
function constructed(node: SgNode, index: FileIndex, call: SgNode, v: VendorClients): Origin {
  const isNew = node.is("new_expression");
  const ctor = (isNew ? node.field("constructor") : node.field("function"))?.text();
  if (!ctor || !/^[\w$.]+$/.test(ctor)) return "unknown";
  const pkgs = [...(index.imports.get(ctor.split(".")[0]!) ?? [])].map(rootPackage);
  if (pkgs.length === 0) return "unknown";
  // Foreign only when every way this name could have been imported is a look-alike.
  if (pkgs.every((p) => v.lookalikePackages.includes(p))) return "foreign";
  // A wrapper or factory from any other package (wrapOpenAI, instructor, a local helper) is the
  // vendor's client underneath as far as this file can tell.
  if (!pkgs.some((p) => v.packages.includes(p))) return "unknown";
  const base = baseAddress(node.field("arguments"), index, call);
  return base ? urlOrigin(base, v) : "vendor";
}

const WRAPPERS = new Set(["parenthesized_expression", "as_expression", "non_null_expression", "satisfies_expression", "await_expression"]);

/** `x` from `(x)`, `x as T`, `x!`, `await x` and the like; undefined for a wrapper with nothing inside. */
export function unwrap(node: SgNode): SgNode | undefined {
  let n: SgNode | undefined = node;
  while (n && WRAPPERS.has(String(n.kind()))) n = n.children().find((c) => c.isNamed() && !c.is("comment"));
  return n;
}

/** The client expression an SDK call hangs off: `x` in `x.beta.chat.completions.create`. */
function clientNode(callee: SgNode, symbol: string): SgNode | undefined {
  let node: SgNode | null = callee;
  for (let i = 0; i < symbol.split(".").length && node; i++) node = node.field("object");
  if (node && (node.is("member_expression") || node.is("attribute")) && (node.field("property") ?? node.field("attribute"))?.text() === "beta") {
    node = node.field("object");
  }
  return node ? unwrap(node) : undefined;
}

/**
 * Where the client behind an SDK call comes from, judged from this file alone. `call` is the call
 * node and `symbol` the vendor method it matched (`chat.completions.parse`).
 */
export function clientOrigin(root: SgNode, call: SgNode, symbol: string, v: VendorClients): Origin {
  const callee = call.field("function");
  const client = callee && clientNode(callee, symbol);
  if (!client) return "unknown";
  const index = indexOf(root);
  if (client.is("new_expression") || client.is("call_expression") || client.is("call")) return constructed(client, index, call, v);
  const target = client.text().replace(/\s+/g, "");
  if (!/^(?:(?:this|self)\.)?[\w$#]+$/.test(target)) return "unknown";
  const origins = visibleAssignments(index, target, call).map((a) =>
    a.value.is("new_expression") || a.value.is("call_expression") || a.value.is("call") ? constructed(a.value, index, call, v) : "unknown",
  );
  if (origins.length === 0) return "unknown";
  // Foreign only when every assignment the call could see is a look-alike; local only when every one is local.
  if (origins.every((o) => o === "foreign")) return "foreign";
  if (origins.every((o) => typeof o === "object")) return { local: [...new Set(origins.flatMap((o) => o.local))].sort() };
  return origins.includes("vendor") ? "vendor" : "unknown";
}
