import { extname } from "node:path";
import python from "@ast-grep/lang-python";
import { Lang as NapiLang, parse, registerDynamicLanguage, type SgNode } from "@ast-grep/napi";
import type { AstGrepPattern, Lang } from "../records/schema.js";
import { clientOrigin, urlOrigin, type VendorClients } from "./clients.js";

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
 * or the match must sit inside a call that names one of the vendor's `endpoints`
 * (raw HTTP users). A parameter name like `max_tokens` exists on other vendors'
 * APIs too, where it is correct; without this gate those would be reported.
 */
export type Gate = {
  symbols?: readonly string[] | undefined;
  endpoints?: readonly string[] | undefined;
  /** When given, each match is traced to its client and flagged foreign if it belongs to another provider. */
  vendor?: VendorClients | undefined;
};

const isCall = (n: SgNode) => n.is("call_expression") || n.is("call");

/** Callee text of the nearest enclosing call. Bounded so a detached object literal never inherits a distant call. */
function enclosingCallee(node: SgNode): string | undefined {
  let n: SgNode | null = node;
  for (let i = 0; i < 8 && (n = n.parent()); i++) {
    if (isCall(n)) return n.field("function")?.text();
  }
  return undefined;
}

/** The enclosing call whose text names one of the endpoints (the fetch/request carrying the URL). */
function endpointCall(node: SgNode, endpoints: readonly string[]): SgNode | undefined {
  return node.ancestors().find((a) => isCall(a) && endpoints.some((e) => a.text().includes(e)));
}

/** Every node in `source` matching any of `patterns`, optionally gated. */
export function findMatches(source: string, grammar: Grammar, patterns: readonly AstGrepPattern[], gate?: Gate): Match[] {
  const root = parse(grammar, source).root();
  const symbols = gate?.symbols ?? [];
  const endpoints = gate?.endpoints ?? [];
  const matches: Match[] = [];
  for (const { context, selector } of patterns) {
    for (const node of root.findAll({ rule: { pattern: { context, selector } } })) {
      const { start } = node.range();
      let foreign = false;
      if (symbols.length > 0 || endpoints.length > 0) {
        const callee = enclosingCallee(node);
        const symbol = callee === undefined ? undefined : symbols.filter((s) => callee.endsWith(s)).sort((a, b) => b.length - a.length)[0];
        const viaEndpoint = symbol === undefined && endpoints.length > 0 ? endpointCall(node, endpoints) : undefined;
        if (symbol === undefined && !viaEndpoint) continue;
        if (gate?.vendor) {
          const origin = symbol !== undefined ? clientOrigin(root, callee!, symbol, start.line, gate.vendor) : urlOrigin(viaEndpoint!.text(), gate.vendor);
          foreign = origin === "foreign";
        }
      }
      matches.push({ line: start.line + 1, column: start.column + 1, text: node.text(), ...(foreign ? { foreign: true as const } : {}) });
    }
  }
  return matches.sort((a, b) => a.line - b.line || a.column - b.column);
}
