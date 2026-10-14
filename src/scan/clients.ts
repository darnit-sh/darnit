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

/** A function or block around a node, and the ones around it. */
type Scope = { node: SgNode; fn: boolean; outer: Scope | undefined };
/** Where a node sits: the function it is in (unless a class is nearer), its class, its block or function, its parent, every function and block around it. */
type Context = { fn?: SgNode | undefined; cls?: SgNode | undefined; block?: SgNode | undefined; parent?: SgNode; scope?: Scope | undefined };
/** A client's origin, or the name its base address is read from, which depends on where the call is. */
type Built = Origin | { name: string };
type Assignment = { target: string; value: SgNode; node: SgNode; field: boolean; blockScoped: boolean; built?: Built } & Context;
/** Assignments by name, then by the node they live in: a function or block, a class, or undefined for the whole file. */
type Grouped = Map<string, Map<SgNode | undefined, Assignment[]>>;
type FileIndex = { imports: Map<string, Set<string>>; scoped: Grouped; classed: Grouped; calls: Map<number, Context>; globalHomes: Map<string, SgNode[]> };

/**
 * Local name → every package it is imported from, read from import statements only (never comments or strings).
 * Each text is one whole statement of any size, so every pattern is anchored at its start and runs in
 * time proportional to the text.
 */
function importsOf(statements: readonly string[]): Map<string, Set<string>> {
  const names = new Map<string, Set<string>>();
  const add = (name: string, pkg: string) => {
    if (!name.trim()) return;
    const set = names.get(name.trim()) ?? new Set<string>();
    set.add(pkg);
    names.set(name.trim(), set);
  };
  for (const text of statements) {
    const esm = /^import\s+(?=\S)([^;'"]*?[^;'"\s])\s+from\s+["']([^"']+)["']/.exec(text);
    if (esm) {
      const [clause, pkg] = [esm[1]!.replace(/^type\s+/, ""), esm[2]!];
      const ns = /\*\s+as\s+([\w$]+)/.exec(clause);
      if (ns) add(ns[1]!, pkg);
      const def = /^\s*([\w$]+)/.exec(clause);
      if (def && !/^\s*[{*]/.test(clause)) add(def[1]!, pkg);
      for (const part of /\{([^{}]*)\}/.exec(clause)?.[1]?.split(",") ?? []) {
        const alias = /^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?/.exec(part.trim());
        if (alias) add(alias[2] ?? alias[1]!, pkg);
      }
    }
    const req = /^([^=;]*?[^=;\s])\s*=\s*require\(\s*["']([^"']+)["']\s*\)/.exec(text);
    if (req) {
      const [target, pkg] = [req[1]!.replace(/^\s*(?:const|let|var|import)\s+/, "").trim(), req[2]!];
      const destructured = /^\{([^}]*)\}$/.exec(target);
      if (!destructured) add(target, pkg);
      for (const part of destructured?.[1]!.split(",") ?? []) {
        const alias = /([\w$]+)\s*(?::\s*([\w$]+))?/.exec(part.trim());
        if (alias) add(alias[2] ?? alias[1]!, pkg);
      }
    }
    const from = /^from\s+([\w.]+)\s+import\s+(?:\(([^)]*)\)|([^\n]+))/.exec(text);
    for (const part of from ? (from[2] ?? from[3]!).split(",") : []) {
      const alias = /^([\w]+)(?:\s+as\s+([\w]+))?/.exec(part.trim());
      if (alias) add(alias[2] ?? alias[1]!, from![1]!);
    }
    for (const part of /^import\s([\w.,\s]+)$/.exec(text.trimEnd())?.[1]!.split(",") ?? []) {
      const alias = /^([\w.]+)(?:\s+as\s+(\w+))?$/.exec(part.trim());
      if (alias) add(alias[2] ?? alias[1]!.split(".")[0]!, alias[1]!);
    }
  }
  return names;
}

// A placeholder such as `client = null` is not a client. Only a short value is read.
const isPlaceholder = (value: SgNode) => value.range().end.index - value.range().start.index <= 9 && /^(null|undefined|None)$/.test(value.text());

// One iterative walk and one import read per parsed file, however many calls it has. Iterative so
// a deeply nested generated file can't overflow the stack, and it keeps each node's surroundings
// on the way down, since asking a node for its ancestors walks down from the root.
const indexes = new WeakMap<SgNode, FileIndex>();

function indexOf(root: SgNode): FileIndex {
  let index = indexes.get(root);
  if (index) return index;
  const scoped: Grouped = new Map();
  const classed: Grouped = new Map();
  const add = (groups: Grouped, home: SgNode | undefined, a: Assignment) => {
    const byHome = groups.get(a.target) ?? new Map<SgNode | undefined, Assignment[]>();
    const list = byHome.get(home) ?? [];
    list.push(a);
    byHome.set(home, list);
    groups.set(a.target, byHome);
  };
  const calls = new Map<number, Context>();
  const importTexts: string[] = [];
  const stack: [SgNode, Context][] = [[root, {}]];
  while (stack.length > 0) {
    const [node, up] = stack.pop()!;
    const kind = String(node.kind());
    if (IMPORTS.has(kind)) importTexts.push(node.text());
    if (ASSIGNMENTS.has(kind)) {
      const target = (node.field("name") ?? node.field("left") ?? node.field("property"))?.text();
      const value = node.field("value") ?? node.field("right");
      if (target && value) {
        if ((value.is("call_expression") || value.is("member_expression")) && /^require\s*\(/.test(value.text())) importTexts.push(node.text());
        // A Python class-body assignment is a class attribute: reached as self.x, not as a bare name.
        const field = FIELDS.has(kind) || (kind === "assignment" && up.cls !== undefined && up.fn === undefined);
        const blockScoped = kind === "variable_declarator" && up.parent?.is("lexical_declaration") === true;
        if (!isPlaceholder(value)) {
          const a = { target, value, node, field, blockScoped, ...up };
          // let and const live in their block; var and plain assignments live in the whole function.
          if (!field) add(scoped, blockScoped && up.block ? up.block : up.fn, a);
          add(classed, up.cls, a);
        }
      }
    }
    if (kind === "call_expression" || kind === "call") calls.set(node.id(), up);
    const [isFunction, isClass] = [FUNCTIONS.has(kind), CLASSES.has(kind)];
    const isBlock = isFunction || kind === "statement_block";
    const scope = isBlock ? { node, fn: isFunction, outer: up.scope } : up.scope;
    const inner = { fn: isFunction ? node : isClass ? undefined : up.fn, cls: isClass ? node : up.cls, block: isBlock ? node : up.block, parent: node, scope };
    for (const child of node.children()) stack.push([child, inner]);
  }
  index = { imports: importsOf(importTexts), scoped, classed, calls, globalHomes: new Map() };
  indexes.set(root, index);
  return index;
}

// Read once per node: a crafted file can pair thousands of assignments with thousands of calls.
const spans = new WeakMap<SgNode, [number, number]>();
const globals = new WeakMap<SgNode, Set<string>>();
const params = new WeakMap<SgNode, string[]>();

function span(node: SgNode): [number, number] {
  let s = spans.get(node);
  if (!s) spans.set(node, (s = [node.range().start.index, node.range().end.index]));
  return s;
}

const contains = (outer: SgNode, inner: SgNode) => span(outer)[0] <= span(inner)[0] && span(inner)[1] <= span(outer)[1];

/** Parameter names of a function node (JavaScript, TypeScript or Python). */
function parameters(fn: SgNode): string[] {
  let names = params.get(fn);
  if (!names) params.set(fn, (names = readParameters(fn)));
  return names;
}

function readParameters(fn: SgNode): string[] {
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
function declaresGlobal(fn: SgNode, name: string): boolean {
  let names = globals.get(fn);
  if (!names) {
    const statements = String(fn.kind()) === "function_definition" ? fn.findAll({ rule: { kind: "global_statement" } }) : [];
    globals.set(fn, (names = new Set(statements.flatMap((g) => g.children().filter((c) => c.is("identifier")).map((c) => c.text())))));
  }
  return names.has(name);
}

// Tracing a call takes time in proportion to the assignments that reach it, so a name assigned more
// often than this where one call can see it is not traced, and its calls count as the vendor's.
const MAX_TRACED = 50;

/** Every assignment to `target` that could be the value the call sees. */
function visibleAssignments(index: FileIndex, target: string, call: SgNode): Assignment[] {
  const visible = reachingAssignments(index, target, call);
  // A let or const in an inner block hides one of the same name in a block around it.
  const blocks = visible.filter((a) => a.blockScoped).map((a) => a.block);
  return visible.filter((a) => {
    const block = a.blockScoped ? a.block : undefined;
    return !block || !blocks.some((b) => b && span(b)[0] !== span(block)[0] && contains(block, b));
  });
}

/** Assignments to `target` whose scope reaches the call, before any shadowing. */
function reachingAssignments(index: FileIndex, target: string, call: SgNode): Assignment[] {
  const at = index.calls.get(call.id()) ?? {};
  const member = /^(?:this|self)\.([\w$#]+)$/.exec(target)?.[1];
  if (member !== undefined) {
    if (!at.cls) return [];
    const own = [...(index.classed.get(target)?.get(at.cls) ?? []), ...(index.classed.get(member)?.get(at.cls) ?? []).filter((a) => a.field)];
    return own.length > MAX_TRACED ? [] : own;
  }
  const groups = index.scoped.get(target);
  if (!groups) return [];
  // Only assignments in the file's top level, in a function or block around the call, or in a
  // function that declares the name global.
  const homes = new Set<SgNode | undefined>([undefined]);
  for (let s = at.scope; s; s = s.outer) homes.add(s.node);
  const reaching = [...homes].flatMap((home) => groups.get(home) ?? []);
  let global = index.globalHomes.get(target);
  if (!global) index.globalHomes.set(target, (global = [...groups.keys()].filter((home): home is SgNode => home !== undefined && declaresGlobal(home, target))));
  for (const home of global) if (!homes.has(home)) reaching.push(...groups.get(home)!.filter((a) => !a.blockScoped));
  if (reaching.length > MAX_TRACED) return [];
  // A parameter with the same name, between the assignment and the call, shadows it.
  const shadowing: SgNode[] = [];
  for (let s = at.scope; s; s = s.outer) if (s.fn && parameters(s.node).includes(target)) shadowing.push(s.node);
  return reaching.filter((a) => !shadowing.some((fn) => !contains(fn, a.node)));
}

/** The written-out base address in a constructor's arguments, or the name it is read from. Read from the syntax so comments never count. */
function baseAddress(args: SgNode | null): string | { name: string } | undefined {
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
      return value.is("identifier") || value.is("shorthand_property_identifier") ? { name: value.text() } : undefined;
    }
    // Don't descend into nested calls or functions: their options are not this client's.
    if (node === args || !(node.is("call_expression") || node.is("call") || node.is("new_expression") || FUNCTIONS.has(String(node.kind())))) {
      for (const child of node.children()) stack.push(child);
    }
  }
  return undefined;
}

/** Origin of a client built as `new C(args)` or `C(args)`. */
function constructed(node: SgNode, index: FileIndex, v: VendorClients): Built {
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
  const base = baseAddress(node.field("arguments"));
  return typeof base === "object" ? base : base ? urlOrigin(base, v) : "vendor";
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
  const byName = new Map<string, Origin>();
  const traced = (built: Built): Origin => {
    if (typeof built !== "object" || !("name" in built)) return built;
    let origin = byName.get(built.name);
    if (!origin) {
      const consts = visibleAssignments(index, built.name, call).map((a) => stringText(a.value));
      byName.set(built.name, (origin = consts.length === 1 && consts[0] ? urlOrigin(consts[0], v) : "vendor"));
    }
    return origin;
  };
  if (client.is("new_expression") || client.is("call_expression") || client.is("call")) return traced(constructed(client, index, v));
  const target = client.text().replace(/\s+/g, "");
  if (!/^(?:(?:this|self)\.)?[\w$#]+$/.test(target)) return "unknown";
  const origins: Origin[] = [];
  for (const a of visibleAssignments(index, target, call)) {
    a.built ??= a.value.is("new_expression") || a.value.is("call_expression") || a.value.is("call") ? constructed(a.value, index, v) : "unknown";
    const origin = traced(a.built);
    // One vendor client among them settles it.
    if (origin === "vendor") return "vendor";
    origins.push(origin);
  }
  if (origins.length === 0) return "unknown";
  // Foreign only when every assignment the call could see is a look-alike; local only when every one is local.
  if (origins.every((o) => o === "foreign")) return "foreign";
  if (origins.every((o) => typeof o === "object")) return { local: [...new Set(origins.flatMap((o) => o.local))].sort() };
  return origins.includes("vendor") ? "vendor" : "unknown";
}
