import { basename } from "node:path";
import { parse, type SgNode } from "@ast-grep/napi";
import type { Grammar, Match } from "./astgrep.js";
import { stringText } from "./clients.js";

export type ModelValue = Match & { model: string };

const NAMED = /model|engine/i;
const TOKEN = /token/i;
const ENV_READ = /process\.env|import\.meta\.env|os\.environ|getenv|\benv\.get|environ\.get/;
const ENV_CALL = /(getenv|environ\.get|environ\.setdefault|env\.get)$/;
const FALLBACK = new Set(["||", "??", "or"]);
const PASS = new Set(["parenthesized_expression", "as_expression", "satisfies_expression", "non_null_expression", "ternary_expression", "conditional_expression"]);

/** Test code: test folders, test files by name, fixtures and mocks. */
export const isTestPath = (file: string) =>
  /(^|\/)(tests?|__tests__|spec|specs|fixtures?|mocks?|__mocks__|testdata|e2e)(\/|$)|(^|\/)test_[^/]*\.py$|_test\.py$|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)conftest\.py$/i.test(file);

/** `self.model` → "model", `"model"` → "model". */
const lastName = (text: string) => text.replace(/^["'`]|["'`]$/g, "").split(/[.\s]/).pop() ?? "";

/** A node's text when it is short, so a crafted file cannot make each lookup read the whole file. */
const short = (n: SgNode | null | undefined) => (n && n.range().end.index - n.range().start.index < 200 ? n.text() : "");

const same = (a: SgNode | null | undefined, b: SgNode) => a?.range().start.index === b.range().start.index;

const namedArgs = (args: SgNode) => args.children().filter((c) => c.isNamed() && !c.is("comment"));

/** The name a value is bound to, when `node` is the value side of `parent`. */
function boundName(parent: SgNode, node: SgNode): string | undefined {
  switch (String(parent.kind())) {
    case "pair":
      return same(parent.field("key"), node) ? undefined : lastName(parent.field("key")?.text() ?? "");
    case "keyword_argument":
    case "variable_declarator":
    case "default_parameter":
    case "typed_default_parameter":
      return parent.field("name")?.text();
    case "assignment":
    case "assignment_expression":
    case "assignment_pattern":
    case "object_assignment_pattern":
      return same(parent.field("left"), node) ? undefined : lastName(parent.field("left")?.text() ?? "");
    case "public_field_definition":
    case "field_definition":
      return (parent.field("name") ?? parent.field("property"))?.text();
    case "required_parameter":
    case "optional_parameter":
      return parent.field("pattern")?.text();
  }
  return undefined;
}

/** `default=` on an option named for a model: `add_argument("--model", default=…)`, `model = field(default=…)`, `.option("model", { default: … })`. */
function namedOption(defaultNode: SgNode): boolean {
  let args = defaultNode.parent();
  if (args?.is("object")) args = args.parent();
  if (!args?.is("arguments") && !args?.is("argument_list")) return false;
  const first = namedArgs(args)[0];
  if (first?.is("string") && NAMED.test(first.text())) return true;
  const binding = args.parent()?.parent();
  return binding !== null && binding !== undefined && NAMED.test(boundName(binding, args.parent()!) ?? "");
}

/** Whether a model-name string is set as the value of something named for a model, or as an env read's default. */
function isModelValue(str: SgNode): boolean {
  let node = str;
  let env = false;
  for (let i = 0; i < 6; i++) {
    const parent = node.parent();
    if (!parent) return false;
    if (PASS.has(String(parent.kind()))) {
      node = parent;
      continue;
    }
    if (parent.is("binary_expression") || parent.is("boolean_operator")) {
      if (!FALLBACK.has(parent.field("operator")?.text() ?? "") || !same(parent.field("right"), node)) return false;
      env ||= ENV_READ.test(short(parent.field("left")));
      node = parent;
      continue;
    }
    if (parent.is("arguments") || parent.is("argument_list")) {
      const fn = short(parent.parent()?.field("function"));
      const args = namedArgs(parent);
      if (!same(args[1], node)) return false;
      if (ENV_CALL.test(fn)) return true;
      const key = args[0]!;
      return /\.get$/.test(fn) && key.is("string") && NAMED.test(key.text());
    }
    if (env) return true;
    const isDefault = parent.is("keyword_argument") ? parent.field("name")?.text() === "default" : parent.is("pair") && /^["']?default["']?$/.test(parent.field("key")?.text() ?? "");
    if (isDefault && !same(parent.field("key"), node)) return namedOption(parent);
    return NAMED.test(boundName(parent, node) ?? "");
  }
  return false;
}

/** Where tokenizer code says "token": the callee, function or binding name of these nodes. */
const TOKEN_FIELDS: Record<string, string> = {
  call: "function",
  call_expression: "function",
  function_definition: "name",
  keyword_argument: "name",
  function_declaration: "name",
  function_expression: "name",
  method_definition: "name",
  variable_declarator: "name",
  assignment: "left",
  assignment_expression: "left",
};
const TOKEN_KINDS = {
  py: ["call", "function_definition", "keyword_argument", "assignment"],
  js: ["call_expression", "function_declaration", "function_expression", "method_definition", "variable_declarator", "assignment_expression"],
};

/** Whether [start, end) sits inside one of `ranges`, which are sorted and do not overlap. */
function inside(ranges: { start: number; end: number }[], start: number, end: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid]!.start <= start) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi >= 0 && end <= ranges[hi]!.end;
}

/**
 * Strings exactly equal to one of `names`, set as the value of something named for a model or
 * engine: a constant, a default, a keyword argument, an object or dict entry, an env read's default.
 * Comments, dict keys, comparisons, list items and types are left out by the parser.
 */
export function findModelValues(file: string, source: string, grammar: Grammar, names: ReadonlySet<string>): ModelValue[] {
  if (TOKEN.test(basename(file)) || ![...names].some((n) => source.includes(n))) return [];
  const root = parse(grammar, source).root();
  const lines = source.split("\n");
  const py = file.endsWith(".py");
  // Tokenizer code names a model to count tokens, not to call it. Only a short plain dotted name
  // counts: a chained call's callee holds the whole chain, and walking up from each name is slow in deep code.
  const tokenizers: { start: number; end: number }[] = [];
  if (TOKEN.test(source)) {
    for (const n of root.findAll({ rule: { any: TOKEN_KINDS[py ? "py" : "js"].map((kind) => ({ kind })) } })) {
      if (!/^[\w.$]*token[\w.$]*$/i.test(short(n.field(TOKEN_FIELDS[String(n.kind())]!)))) continue;
      const { start, end } = n.range();
      if (start.index >= (tokenizers.at(-1)?.end ?? -1)) tokenizers.push({ start: start.index, end: end.index });
    }
  }
  const out: ModelValue[] = [];
  for (const str of root.findAll({ rule: { any: (py ? ["string"] : ["string", "template_string"]).map((kind) => ({ kind })) } })) {
    const model = stringText(str);
    if (model === undefined || !names.has(model) || !isModelValue(str)) continue;
    const { start, end } = str.range();
    if (inside(tokenizers, start.index, end.index)) continue;
    const { line, column } = start;
    out.push({ line: line + 1, column: column + 1, text: lines[line]!.trim().slice(0, 200), model });
  }
  return out;
}
