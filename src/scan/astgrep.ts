import { extname } from "node:path";
import python from "@ast-grep/lang-python";
import { Lang as NapiLang, parse, registerDynamicLanguage, type SgNode } from "@ast-grep/napi";
import type { AstGrepPattern, Lang } from "../records/schema.js";

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
};

/**
 * Keeps a match only when it belongs to the vendor's own API surface: the
 * enclosing call must be one of `symbols` (e.g. `chat.completions.create`), or
 * the file must reference one of the vendor's `endpoints` (raw HTTP users). A
 * parameter name like `max_tokens` exists on other vendors' APIs too, where it
 * is correct; without this gate those would be reported.
 */
export type Gate = { symbols?: readonly string[] | undefined; endpoints?: readonly string[] | undefined };

/** Callee text of the nearest enclosing call, looking at most three levels up. */
function enclosingCallee(node: SgNode): string | undefined {
  let n: SgNode | null = node;
  for (let i = 0; i < 3 && (n = n.parent()); i++) {
    if (n.is("call_expression") || n.is("call")) return n.field("function")?.text();
  }
  return undefined;
}

/** Every node in `source` matching any of `patterns`, optionally gated. */
export function findMatches(source: string, grammar: Grammar, patterns: readonly AstGrepPattern[], gate?: Gate): Match[] {
  const root = parse(grammar, source).root();
  const symbols = gate?.symbols ?? [];
  const viaEndpoint = gate?.endpoints?.some((e) => source.includes(e)) ?? false;
  const matches: Match[] = [];
  for (const { context, selector } of patterns) {
    for (const node of root.findAll({ rule: { pattern: { context, selector } } })) {
      if (symbols.length > 0 && !viaEndpoint) {
        const callee = enclosingCallee(node);
        if (!callee || !symbols.some((s) => callee.endsWith(s))) continue;
      }
      const { start } = node.range();
      matches.push({ line: start.line + 1, column: start.column + 1, text: node.text() });
    }
  }
  return matches.sort((a, b) => a.line - b.line || a.column - b.column);
}
