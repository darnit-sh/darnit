import { extname } from "node:path";
import python from "@ast-grep/lang-python";
import { kind as kindId, Lang as NapiLang, parse, registerDynamicLanguage, type SgNode } from "@ast-grep/napi";
import { escapeRegExp } from "../detect.js";
import type { AstGrepPattern, Lang } from "../records/schema.js";
import { clientOrigin, FUNCTIONS, isStatic, stringText, unwrap, urlOrigin, vendorClass, type VendorClients } from "./clients.js";
import { inside, joined } from "./values.js";

/** A built-in napi grammar or the name of a registered dynamic one. */
export type Grammar = Parameters<typeof parse>[0];

// napi ships only the web grammars built in; Python is a plug-in grammar and
// must be registered exactly once per process; here, at module load.
registerDynamicLanguage({ python });

// A record's "js" patterns are written against the JavaScript grammar; the
// TypeScript/TSX grammars share the node kinds those patterns select (pair,
// call_expression, ...), so one pattern set covers all four extensions.
const GRAMMAR_BY_EXT: Record<string, { lang: Lang; grammar: Grammar }> = {
  ".js": { lang: "js", grammar: NapiLang.JavaScript },
  ".mjs": { lang: "js", grammar: NapiLang.JavaScript },
  ".cjs": { lang: "js", grammar: NapiLang.JavaScript },
  ".jsx": { lang: "js", grammar: NapiLang.JavaScript },
  ".ts": { lang: "js", grammar: NapiLang.TypeScript },
  ".mts": { lang: "js", grammar: NapiLang.TypeScript },
  ".cts": { lang: "js", grammar: NapiLang.TypeScript },
  ".tsx": { lang: "js", grammar: NapiLang.Tsx },
  ".py": { lang: "py", grammar: "python" },
};

export function grammarFor(file: string): { lang: Lang; grammar: Grammar } | undefined {
  return GRAMMAR_BY_EXT[extname(file)];
}

export type Span = { start: number; end: number };

export type Match = {
  /** 1-based line of the match start. */
  line: number;
  /** 1-based column of the match start. */
  column: number;
  text: string;
  /** Character offsets of the matched text in the file. */
  span: Span;
  /** The file shows this call goes to another provider through the same methods (only set with a vendor gate). */
  foreign?: true;
  /** The private addresses the file shows this call is sent to, such as "localhost:11434" (only set with a vendor gate). */
  local?: string[];
};

/**
 * Keeps a match only when it belongs to the vendor's own API surface: the
 * nearest enclosing call must be one of `symbols` (e.g. `chat.completions.create`),
 * or the match must sit inside a request call whose URL argument names one of the
 * vendor's `endpoints` (raw HTTP users). A parameter name like `max_tokens` exists on
 * other vendors' APIs too, where it is correct; without this gate those would be reported.
 */
export type Gate = {
  symbols?: readonly string[] | undefined;
  endpoints?: readonly string[] | undefined;
  /** When given, each match is traced to its client and flagged foreign if it belongs to another provider. */
  vendor?: VendorClients | undefined;
};

const isCall = (n: SgNode) => n.is("call_expression") || n.is("call");

/** Callee text as written, minus line breaks and optional chaining, so `chat?.completions\n .create` still matches. */
const normalized = (callee: string) => callee.replace(/\s+/g, "").replace(/\?\./g, ".");

// Code inside a URL (an interpolation, a helper call) is not URL text.
const OPAQUE = ["template_substitution", "interpolation", "call_expression", "call"];
const URL_KINDS = new Set(["string", "template_string", "concatenated_string", "binary_expression", "binary_operator", "ternary_expression", "conditional_expression"]);

/** Arguments that could be a request's URL: positional ones, `url=`, and `url:` in an options object. */
function urlCandidates(call: SgNode): SgNode[] {
  const out: SgNode[] = [];
  for (const arg of call.field("arguments")?.children().filter((c) => c.isNamed()) ?? []) {
    if (arg.is("keyword_argument")) {
      if (arg.field("name")?.text() === "url") out.push(arg.field("value")!);
    } else if (arg.is("object")) {
      const url = arg.children().find((p) => p.is("pair") && /^["']?url["']?$/.test(p.field("key")?.text() ?? ""));
      if (url) out.push(url.field("value")!);
    } else out.push(arg);
  }
  return out.flatMap((arg) => {
    const n = unwrap(arg);
    if (n?.is("new_expression") && n.field("constructor")?.text() === "URL") return n.field("arguments")?.children().find((c) => c.isNamed()) ?? [];
    return n ?? [];
  });
}

/** Rules for `kinds`, leaving out the ones `grammar` lacks: asking for one is an error. */
const anyKind = (grammar: Grammar, kinds: readonly string[]) => ({ any: kinds.filter((kind) => kindId(grammar, kind) !== 0).map((kind) => ({ kind })) });

/**
 * Whether a URL argument holds an endpoint as a URL or path would: in a literal piece of a string (between interpolations)
 * or of a concatenation, with nothing but URL text before it. The parser finds the pieces, so a concatenation
 * thousands deep is never walked here.
 */
function endpointTest(grammar: Grammar, endpoints: readonly string[]): (url: SgNode) => boolean {
  const pieces = { rule: { ...anyKind(grammar, ["string_fragment", "string_content"]), regex: endpoints.map(escapeRegExp).join("|") } };
  const code = { rule: anyKind(grammar, OPAQUE) };
  return (url) => {
    if (!URL_KINDS.has(String(url.kind()))) return false;
    const found = url.findAll(pieces);
    if (found.length === 0) return false;
    const opaque = joined(url.findAll(code).map((c) => ({ start: c.range().start.index, end: c.range().end.index })));
    return found.some((piece) => {
      const { start, end } = piece.range();
      const text = piece.text();
      return !inside(opaque, start.index, end.index) && endpoints.some((e) => text.includes(e) && !/\s/.test(text.slice(0, text.indexOf(e))));
    });
  };
}

/** An ancestor of a match. `url` is kept once read: the endpoint URL of the raw request a node directly inside it belongs to, or null. */
type Frame = { node: SgNode; url?: string | null };

/**
 * The raw HTTP request a match belongs to, with its URL text: the nearest enclosing call that has
 * an endpoint URL as an argument. Stops at a function, so a route handler, mock or test body
 * never borrows the URL of the call it is passed to. `up` holds the match's ancestors.
 */
function endpointUrl(up: readonly Frame[], namesEndpoint: (url: SgNode) => boolean): string | undefined {
  const read: Frame[] = [];
  let url: string | null = null;
  for (let i = up.length - 1; i >= 0; i--) {
    const { node, url: known } = up[i]!;
    if (known !== undefined) {
      url = known;
      break;
    }
    read.push(up[i]!);
    if (FUNCTIONS.has(String(node.kind()))) break;
    const found = isCall(node) ? urlCandidates(node).find(namesEndpoint) : undefined;
    if (found) {
      url = stringText(found) ?? found.text().replace(/^[fFrRbBuU]*[`'"]/, "");
      break;
    }
  }
  for (const f of read) f.url = url;
  return url ?? undefined;
}

type Request = { call: SgNode | undefined; symbol: string | undefined; url: string | undefined };

/**
 * For each node, the call it belongs to: its nearest enclosing call (at most 8 levels up, so a
 * detached object literal never inherits a distant call) with the vendor method that call matched,
 * or else the URL of the raw request around it. One walk down from the root keeps each node's
 * ancestors, since asking a node for its parent walks down from the root each time.
 */
function requests(root: SgNode, nodes: readonly SgNode[], symbols: readonly string[], namesEndpoint: ((url: SgNode) => boolean) | undefined, isVendorClass: (callee: string) => boolean): Map<number, Request> {
  const wanted = new Set(nodes.map((n) => n.id()));
  const starts = [...new Set(nodes.map((n) => n.range().start.index))].sort((a, b) => a - b);
  /** The first match starting at or after `at`. */
  const next = (at: number) => {
    let [lo, hi] = [0, starts.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid]! < at) lo = mid + 1;
      else hi = mid;
    }
    return starts[lo] ?? Infinity;
  };
  const out = new Map<number, Request>();
  const up: Frame[] = [];
  const todo = [{ node: root, depth: 0, start: 0 }];
  while (todo.length > 0) {
    const { node, depth, start } = todo.pop()!;
    up.length = depth;
    if (next(start) === start && wanted.has(node.id())) {
      const call = up.slice(-8).reverse().find((f) => isCall(f.node))?.node;
      const raw = call?.field("function")?.text();
      const callee = raw === undefined ? undefined : normalized(raw);
      const symbol = callee === undefined ? undefined : symbols.filter((s) => callee.endsWith(s) && (!isStatic(s) || isVendorClass(callee))).sort((a, b) => b.length - a.length)[0];
      const url = symbol === undefined && namesEndpoint ? endpointUrl(up, namesEndpoint) : undefined;
      out.set(node.id(), { call, symbol, url });
    }
    up.push({ node });
    const kids = node.namedChildren();
    for (let k = kids.length - 1; k >= 0; k--) {
      const { start, end } = kids[k]!.range();
      if (next(start.index) < end.index) todo.push({ node: kids[k]!, depth: depth + 1, start: start.index });
    }
  }
  return out;
}

/**
 * Quoted plain names in a pattern, such as a model name: code without that text cannot match it.
 * Anything else in quotes (a $VAR, spaces, escapes) is left to the parser. Assumes quoted text
 * sits inside the selected node, as in every record today; the fixtures would catch one that
 * does not.
 */
const literals = (context: string) => [...context.matchAll(/(["'])([\w.:/-]+)\1/g)].map((m) => m[2]!);

const QUOTED = String.raw`("[^"]*"|'[^']*')`;
const JS_VALUE = new RegExp(String.raw`^\(\{\s*(\w+):\s*${QUOTED}\s*\}\)$`);
const PY_VALUE = new RegExp(String.raw`^f\((\w+)=${QUOTED}\)$`);

/** The model names a record's patterns match as `model: "name"`, such as a shutdown record's models. */
export const modelNames = (patterns: readonly AstGrepPattern[]) =>
  patterns.flatMap((p) => {
    const m = JS_VALUE.exec(p.context) ?? PY_VALUE.exec(p.context);
    return m?.[1] === "model" ? literals(m[2]!) : [];
  });

const JS_KEY = /^\(\{\s*([A-Za-z_]\w*)\s*:([\s\S]*)\}\)$/;
const PY_KEY = /^f\(([A-Za-z_]\w*)=([\s\S]*)\)$/;
const JS_QUOTED_KEY = /^\(\{\s*(["'])([A-Za-z_]\w*)\1\s*:([\s\S]*)\}\)$/;
const PY_QUOTED_KEY = /^\{\s*(["'])([A-Za-z_]\w*)\1\s*:([\s\S]*)\}$/;

/** A record's quoted-key pattern that its bare-key pattern already matches, as `ruleFor` adds the quoted key: matching both would count each node twice. */
function covered(p: AstGrepPattern, all: readonly AstGrepPattern[]): boolean {
  const js = p.selector === "pair" ? JS_QUOTED_KEY.exec(p.context) : null;
  const quoted = js ?? (p.selector === "pair" ? PY_QUOTED_KEY.exec(p.context) : null);
  if (!quoted) return false;
  return all.some((b) => {
    const bare = js ? (b.selector === "pair" ? JS_KEY.exec(b.context) : null) : b.selector === "keyword_argument" ? PY_KEY.exec(b.context) : null;
    return bare !== null && bare[1] === quoted[2] && bare[2]!.trim() === quoted[3]!.trim();
  });
}

// The key of a pattern that also matches the key quoted; no record uses this name.
const KEY = "DARNIT_KEY";

/**
 * A pattern whose value is one quoted string also matches that string as the last fallback:
 * `model: opts.model ?? "gpt-4"` (or `||`, or Python's `or`) sends gpt-4 whenever no model is passed.
 * A bare key also matches it quoted, as raw HTTP bodies write it: `{ "max_tokens": 5 }`, and Python's
 * `{"max_tokens": 5}` for `max_tokens=5`. Only when the file's `source` holds the quoted key, as that costs time.
 */
function ruleFor(context: string, selector: string, source?: string) {
  const js = JS_VALUE.exec(context);
  const py = PY_VALUE.exec(context);
  const fallbacks = js
    ? [`({ ${js[1]}: $_ ?? ${js[2]} })`, `({ ${js[1]}: $_ || ${js[2]} })`]
    : py
      ? [`f(${py[1]}=$_ or ${py[2]})`]
      : [];
  const forms = [context, ...fallbacks].map((c) => ({ context: c, selector }));
  const jsKey = selector === "pair" ? JS_KEY.exec(context)?.[1] : undefined;
  const pyKey = selector === "keyword_argument" ? PY_KEY.exec(context)?.[1] : undefined;
  const key = jsKey ?? pyKey;
  if (key === undefined || (source !== undefined && !source.includes(`"${key}"`) && !source.includes(`'${key}'`))) return { rule: { any: forms.map((pattern) => ({ pattern })) } };
  const patterns = jsKey
    ? forms.map((f) => ({ context: f.context.replace(JS_KEY, `({ $${KEY}:$2})`), selector }))
    : [...forms, ...forms.map((f) => ({ context: f.context.replace(PY_KEY, `{$${KEY}: $2}`), selector: "pair" }))];
  const quoted = `"${key}"|'${key}'`;
  return { rule: { any: patterns.map((pattern) => ({ pattern })) }, constraints: { [KEY]: { regex: `^(?:${jsKey ? `${key}|` : ""}${quoted})$` } } };
}

// Pattern sets that compiled, so records loaded again in the same process are not compiled again.
const compiledSets = new Set<string>();

/**
 * Compiles `patterns` for every grammar a `lang` file is parsed with, so a pattern ast-grep rejects
 * fails when its record loads instead of on the first file it would scan. Throws naming the pattern and grammar.
 */
export function compilePatterns(lang: Lang, patterns: readonly AstGrepPattern[]): void {
  const key = `${lang}\0${JSON.stringify(patterns)}`;
  if (compiledSets.has(key)) return;
  for (const grammar of new Set(Object.values(GRAMMAR_BY_EXT).filter((g) => g.lang === lang).map((g) => g.grammar))) {
    const root = parse(grammar, "").root();
    for (const [i, { context, selector }] of patterns.entries()) {
      try {
        // With quoted keys: the same forms, an identifier key aside, so they compile when the plain ones do.
        root.findAll(ruleFor(context, selector));
      } catch (err) {
        throw new Error(`${lang} pattern ${i + 1} does not compile for ${String(grammar).toLowerCase()}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
    }
  }
  compiledSets.add(key);
}

/** Every node in `source` matching any of `patterns`, optionally gated. `parsed` gives the file's syntax tree, so callers can share one. */
export function findMatches(source: string, grammar: Grammar, allPatterns: readonly AstGrepPattern[], gate?: Gate, parsed = () => parse(grammar, source).root()): Match[] {
  // A plain text check before parsing: most files contain none of a pattern's quoted text.
  const patterns = allPatterns.filter((p) => literals(p.context).every((l) => source.includes(l)) && !covered(p, allPatterns));
  if (patterns.length === 0) return [];
  const root = parsed();
  const symbols = gate?.symbols ?? [];
  const endpoints = gate?.endpoints ?? [];
  const found = patterns.map(({ context, selector }) => root.findAll(ruleFor(context, selector, source)));
  // A static call counts only on the vendor's own class, never a local or another package's of the same name.
  const classes = new Map<string, boolean>();
  const isVendorClass = (callee: string) => {
    if (!gate?.vendor) return true;
    const name = callee.split(".")[0]!;
    if (!classes.has(name)) classes.set(name, vendorClass(root, grammar, callee, gate.vendor));
    return classes.get(name)!;
  };
  const gated = symbols.length > 0 || endpoints.length > 0 ? requests(root, found.flat(), symbols, endpoints.length > 0 ? endpointTest(grammar, endpoints) : undefined, isVendorClass) : undefined;
  const matches: Match[] = [];
  for (const nodes of found) {
    for (const node of nodes) {
      const { start, end } = node.range();
      let foreign = false;
      let local: string[] | undefined;
      if (gated) {
        const { call, symbol, url } = gated.get(node.id())!;
        if (symbol === undefined && url === undefined) continue;
        if (gate?.vendor) {
          const origin = symbol !== undefined ? clientOrigin(root, grammar, call!, symbol, gate.vendor) : urlOrigin(url!, gate.vendor);
          foreign = origin === "foreign";
          local = typeof origin === "object" ? origin.local : undefined;
        }
      }
      matches.push({ line: start.line + 1, column: start.column + 1, text: node.text(), span: { start: start.index, end: end.index }, ...(foreign ? { foreign: true as const } : {}), ...(local ? { local } : {}) });
    }
  }
  return matches.sort((a, b) => a.line - b.line || a.column - b.column);
}
