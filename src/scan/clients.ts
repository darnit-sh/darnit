import type { SgNode } from "@ast-grep/napi";

/** Which packages and hosts belong to a vendor, e.g. openai / api.openai.com. */
export type VendorClients = { packages: readonly string[]; hosts: readonly string[] };

/**
 * Whether a call goes to the vendor. "foreign" means the same file shows it goes elsewhere: a
 * client from another SDK (Groq, Together, ...) or the vendor's own SDK pointed at another host
 * (OpenRouter, DeepSeek, ...). "unknown" means the file can't tell, e.g. the client is a parameter.
 */
export type Origin = "vendor" | "foreign" | "unknown";

const URL_HOST = /[a-z][a-z0-9+.-]*:\/\/([^/\s"'`]+)/gi;

const vendorHost = (host: string, v: VendorClients) => v.hosts.some((h) => host === h || host.endsWith(`.${h}`) || host.endsWith(h));

/** Origin implied by the URLs written out in `text`: foreign when every URL points away from the vendor. */
export function urlOrigin(text: string, v: VendorClients): Origin {
  const hosts = [...text.matchAll(URL_HOST)].map((m) => m[1]!.toLowerCase());
  if (hosts.length === 0) return "unknown";
  return hosts.some((h) => vendorHost(h, v)) ? "vendor" : "foreign";
}

/** Local name → package it was imported from, for JavaScript/TypeScript and Python. */
function importsOf(source: string): Map<string, string> {
  const names = new Map<string, string>();
  const add = (name: string, pkg: string) => names.set(name.trim(), pkg);
  for (const m of source.matchAll(/import\s+([^;'"]+?)\s+from\s+["']([^"']+)["']/g)) {
    const [clause, pkg] = [m[1]!, m[2]!];
    const ns = /\*\s+as\s+([\w$]+)/.exec(clause);
    if (ns) add(ns[1]!, pkg);
    const def = /^\s*([\w$]+)/.exec(clause.replace(/^type\s+/, ""));
    if (def && !clause.trim().startsWith("{") && !clause.trim().startsWith("*")) add(def[1]!, pkg);
    for (const part of /\{([^}]*)\}/.exec(clause)?.[1]?.split(",") ?? []) {
      const alias = /([\w$]+)\s*(?:as\s+([\w$]+))?/.exec(part.trim());
      if (alias) add(alias[2] ?? alias[1]!, pkg);
    }
  }
  for (const m of source.matchAll(/(?:const|let|var)\s+([^=;]+?)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g)) {
    const [target, pkg] = [m[1]!, m[2]!];
    const destructured = /^\{([^}]*)\}$/.exec(target.trim());
    if (destructured) {
      for (const part of destructured[1]!.split(",")) {
        const alias = /([\w$]+)\s*(?::\s*([\w$]+))?/.exec(part.trim());
        if (alias) add(alias[2] ?? alias[1]!, pkg);
      }
    } else add(target, pkg);
  }
  for (const m of source.matchAll(/^\s*from\s+([\w.]+)\s+import\s+\(?([^)\n]+)\)?/gm)) {
    for (const part of m[2]!.split(",")) {
      const alias = /([\w]+)(?:\s+as\s+([\w]+))?/.exec(part.trim());
      if (alias) add(alias[2] ?? alias[1]!, m[1]!);
    }
  }
  for (const m of source.matchAll(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?\s*$/gm)) add(m[2] ?? m[1]!, m[1]!);
  return names;
}

/** "openai/resources" → "openai", "@scope/pkg/x" → "@scope/pkg", "openai.lib.azure" → "openai". */
const rootPackage = (pkg: string) => (pkg.startsWith("@") ? pkg.split("/").slice(0, 2).join("/") : pkg.split(/[/.]/)[0]!);

/** Origin of a client built by calling `ctor` with arguments `args` (a node, or undefined). */
function constructed(ctor: string, args: string, imports: Map<string, string>, v: VendorClients): Origin {
  const head = ctor.split(".")[0]!;
  const pkg = imports.get(head);
  if (pkg === undefined) return "unknown";
  if (!v.packages.includes(rootPackage(pkg))) return "foreign";
  // The vendor's own SDK: a written-out base address decides where the calls go.
  const base = /(?:baseURL|base_url)\s*[:=]\s*(["'`])([^"'`]+)\1/.exec(args);
  return base ? (urlOrigin(base[2]!, v) === "foreign" ? "foreign" : "vendor") : "vendor";
}

/** A client construction: `new C(args)` or `C(args)`. Undefined for anything else. */
function construction(node: SgNode): { ctor: string; args: string } | undefined {
  if (node.is("new_expression")) {
    const ctor = node.field("constructor")?.text();
    return ctor ? { ctor, args: node.field("arguments")?.text() ?? "" } : undefined;
  }
  if (node.is("call_expression") || node.is("call")) {
    const ctor = node.field("function")?.text();
    return ctor && /^[\w$.]+$/.test(ctor) ? { ctor, args: node.field("arguments")?.text() ?? "" } : undefined;
  }
  return undefined;
}

// Kind names differ per grammar (TypeScript has public_field_definition, JavaScript field_definition,
// Python assignment), so the tree is walked and compared by name instead of asking ast-grep for kinds
// a grammar doesn't have.
const ASSIGNMENTS = new Set(["variable_declarator", "assignment_expression", "public_field_definition", "field_definition", "assignment"]);

function* nodesOf(node: SgNode): Generator<SgNode> {
  yield node;
  for (const child of node.children()) yield* nodesOf(child);
}

/** The value last assigned to `target` (e.g. `client`, `this.client`, `self.client`) before line `before`. */
function assignedValue(root: SgNode, target: string, before: number): SgNode | undefined {
  const field = target.replace(/^(this|self)\./, "");
  let found: SgNode | undefined;
  for (const node of nodesOf(root)) {
    if (!ASSIGNMENTS.has(String(node.kind()))) continue;
    const name = (node.field("name") ?? node.field("left") ?? node.field("property"))?.text();
    const isField = node.is("public_field_definition") || node.is("field_definition");
    if (name !== target && !(isField && name === field)) continue;
    const value = node.field("value") ?? node.field("right");
    if (!value) continue;
    // Prefer the nearest assignment above the call; fall back to one below (class fields, late setup).
    if (node.range().start.line <= before || !found) found = value;
  }
  return found;
}

/**
 * Where the client behind an SDK call comes from, judged from this file alone. `callee` is the
 * call's function text (e.g. `client.beta.chat.completions.parse`) and `symbol` the vendor method it
 * matched (`chat.completions.parse`).
 */
export function clientOrigin(root: SgNode, callee: string, symbol: string, line: number, v: VendorClients): Origin {
  const base = callee
    .slice(0, callee.length - symbol.length)
    .replace(/\.$/, "")
    .replace(/\.beta$/, "")
    .trim();
  if (!base) return "unknown";
  const imports = importsOf(root.text());
  const inline = /^(?:new\s+)?([\w$.]+)\s*\(([\s\S]*)\)$/.exec(base);
  if (inline) return constructed(inline[1]!, inline[2]!, imports, v);
  if (!/^(?:(?:this|self)\.)?[\w$]+$/.test(base)) return "unknown";
  const value = assignedValue(root, base, line);
  const built = value && construction(value);
  return built ? constructed(built.ctor, built.args, imports, v) : "unknown";
}
