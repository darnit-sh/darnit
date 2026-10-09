import { extname } from "node:path";
import python from "@ast-grep/lang-python";
import { Lang as NapiLang, parse, registerDynamicLanguage, type SgNode } from "@ast-grep/napi";
import type { AstGrepPattern, Lang } from "../records/schema.js";
import { clientOrigin, FUNCTIONS, stringText, unwrap, urlOrigin, type VendorClients } from "./clients.js";

/** A built-in napi grammar or the name of a registered dynamic one. */
type Grammar = Parameters<typeof parse>[0];

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

export type Match = {
  /** 1-based line of the match start. */
  line: number;
  /** 1-based column of the match start. */
  column: number;
  text: string;
  /** The file shows this call goes to another provider through the same methods (only set with a vendor gate). */
  foreign?: true;
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

/** The nearest enclosing call. Bounded so a detached object literal never inherits a distant call. */
function enclosingCall(node: SgNode): SgNode | undefined {
  let n: SgNode | null = node;
  for (let i = 0; i < 8 && (n = n.parent()); i++) {
    if (isCall(n)) return n;
  }
  return undefined;
}

/** Callee text as written, minus line breaks and optional chaining, so `chat?.completions\n .create` still matches. */
const normalized = (callee: string) => callee.replace(/\s+/g, "").replace(/\?\./g, ".");

// Code inside a URL (an interpolation, a helper call) is not URL text.
const OPAQUE = new Set(["template_substitution", "interpolation", "call_expression", "call"]);
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

/** Literal text pieces of a string (between interpolations) and of each part of a concatenation. */
const pieces = (n: SgNode): SgNode[] =>
  n.is("string_fragment") || n.is("string_content") ? [n] : OPAQUE.has(String(n.kind())) ? [] : n.children().flatMap(pieces);

/** A string piece holds the endpoint as a URL or path would: with nothing but URL text before it. */
const namesEndpoint = (url: SgNode, endpoints: readonly string[]) =>
  URL_KINDS.has(String(url.kind())) &&
  pieces(url).some((piece) => {
    const text = piece.text();
    return endpoints.some((e) => text.includes(e) && !/\s/.test(text.slice(0, text.indexOf(e))));
  });

/**
 * The raw HTTP request a match belongs to, with its URL text: the nearest enclosing call that has
 * an endpoint URL as an argument. Stops at a function, so a route handler, mock or test body
 * never borrows the URL of the call it is passed to.
 */
function endpointCall(node: SgNode, endpoints: readonly string[]): string | undefined {
  for (const a of node.ancestors()) {
    if (FUNCTIONS.has(String(a.kind()))) return undefined;
    if (!isCall(a)) continue;
    const url = urlCandidates(a).find((u) => namesEndpoint(u, endpoints));
    if (url) return stringText(url) ?? url.text().replace(/^[fFrRbBuU]*[`'"]/, "");
  }
  return undefined;
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

/**
 * A pattern whose value is one quoted string also matches that string as the last fallback:
 * `model: opts.model ?? "gpt-4"` (or `||`, or Python's `or`) sends gpt-4 whenever no model is passed.
 */
function ruleFor(context: string, selector: string) {
  const js = JS_VALUE.exec(context);
  const py = PY_VALUE.exec(context);
  const fallbacks = js
    ? [`({ ${js[1]}: $_ ?? ${js[2]} })`, `({ ${js[1]}: $_ || ${js[2]} })`]
    : py
      ? [`f(${py[1]}=$_ or ${py[2]})`]
      : [];
  return { any: [context, ...fallbacks].map((c) => ({ pattern: { context: c, selector } })) };
}

/** Every node in `source` matching any of `patterns`, optionally gated. */
export function findMatches(source: string, grammar: Grammar, allPatterns: readonly AstGrepPattern[], gate?: Gate): Match[] {
  // A plain text check before parsing: most files contain none of a pattern's quoted text.
  const patterns = allPatterns.filter((p) => literals(p.context).every((l) => source.includes(l)));
  if (patterns.length === 0) return [];
  const root = parse(grammar, source).root();
  const symbols = gate?.symbols ?? [];
  const endpoints = gate?.endpoints ?? [];
  const matches: Match[] = [];
  for (const { context, selector } of patterns) {
    for (const node of root.findAll({ rule: ruleFor(context, selector) })) {
      const { start } = node.range();
      let foreign = false;
      if (symbols.length > 0 || endpoints.length > 0) {
        const call = enclosingCall(node);
        const raw = call?.field("function")?.text();
        const callee = raw === undefined ? undefined : normalized(raw);
        const symbol = callee === undefined ? undefined : symbols.filter((s) => callee.endsWith(s)).sort((a, b) => b.length - a.length)[0];
        const viaEndpoint = symbol === undefined && endpoints.length > 0 ? endpointCall(node, endpoints) : undefined;
        if (symbol === undefined && viaEndpoint === undefined) continue;
        if (gate?.vendor) {
          const origin =
            symbol !== undefined ? clientOrigin(root, call!, symbol, gate.vendor) : urlOrigin(viaEndpoint!, gate.vendor);
          foreign = origin === "foreign";
        }
      }
      matches.push({ line: start.line + 1, column: start.column + 1, text: node.text(), ...(foreign ? { foreign: true as const } : {}) });
    }
  }
  return matches.sort((a, b) => a.line - b.line || a.column - b.column);
}
