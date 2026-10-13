import { basename } from "node:path";
import { parse, type SgNode } from "@ast-grep/napi";
import type { Grammar, Match, Span } from "./astgrep.js";
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

const same = (a: SgNode | null | undefined, b: SgNode) => a?.id() === b.id();

/** An ancestor of a string, with its children: asking a node for its parent walks down from the root, which is slow in deep code. */
type Frame = { node: SgNode; kids: SgNode[]; first?: SgNode[] };

/** The first two arguments of an argument list, read once per list. */
function firstArgs(f: Frame): SgNode[] {
  if (!f.first) {
    f.first = [];
    for (let i = 0; i < f.kids.length && f.first.length < 2; i++) if (!f.kids[i]!.is("comment")) f.first.push(f.kids[i]!);
  }
  return f.first;
}

/** The name a value is bound to, when `node` is the value side of `parent`. */
function boundName(parent: SgNode, node: SgNode): string | undefined {
  switch (String(parent.kind())) {
    case "pair":
      return same(parent.field("key"), node) ? undefined : lastName(short(parent.field("key")));
    case "keyword_argument":
    case "variable_declarator":
    case "default_parameter":
    case "typed_default_parameter":
      return short(parent.field("name"));
    case "assignment":
    case "assignment_expression":
    case "assignment_pattern":
    case "object_assignment_pattern":
      return same(parent.field("left"), node) ? undefined : lastName(short(parent.field("left")));
    case "public_field_definition":
    case "field_definition":
      return short(parent.field("name") ?? parent.field("property"));
    case "required_parameter":
    case "optional_parameter":
      return short(parent.field("pattern"));
  }
  return undefined;
}

/** `default=` on an option named for a model: `add_argument("--model", default=…)`, `model = field(default=…)`, `.option("model", { default: … })`. `up[at]` holds the `default` node. */
function namedOption(up: readonly Frame[], at: number): boolean {
  if (up[at - 1]?.node.is("object")) at--;
  const args = up[at - 1];
  if (!args?.node.is("arguments") && !args?.node.is("argument_list")) return false;
  const first = firstArgs(args)[0];
  if (first?.is("string") && NAMED.test(short(first))) return true;
  const binding = up[at - 3]?.node;
  return binding !== undefined && NAMED.test(boundName(binding, up[at - 2]!.node) ?? "");
}

/** Whether a model-name string is set as the value of something named for a model, or as an env read's default. `up` holds its ancestors. */
function isModelValue(str: SgNode, up: readonly Frame[]): boolean {
  let node = str;
  let env = false;
  for (let at = up.length - 1; at >= Math.max(0, up.length - 6); at--) {
    const parent = up[at]!.node;
    const kind = String(parent.kind());
    if (PASS.has(kind)) {
      node = parent;
      continue;
    }
    if (kind === "binary_expression" || kind === "boolean_operator") {
      if (!FALLBACK.has(parent.field("operator")?.text() ?? "") || !same(parent.field("right"), node)) return false;
      env ||= ENV_READ.test(short(parent.field("left")));
      node = parent;
      continue;
    }
    if (kind === "arguments" || kind === "argument_list") {
      const fn = short(up[at - 1]?.node.field("function"));
      const args = firstArgs(up[at]!);
      if (!same(args[1], node)) return false;
      if (ENV_CALL.test(fn)) return true;
      const key = args[0]!;
      return /\.get$/.test(fn) && key.is("string") && NAMED.test(short(key));
    }
    if (env) return true;
    const isDefault = kind === "keyword_argument" ? short(parent.field("name")) === "default" : kind === "pair" && /^["']?default["']?$/.test(short(parent.field("key")));
    if (isDefault && !same(parent.field("key"), node)) return namedOption(up, at);
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
export function inside(ranges: readonly Span[], start: number, end: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid]!.start <= start) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi >= 0 && end <= ranges[hi]!.end;
}

/** `ranges` sorted by start, with overlapping ones joined, ready for `inside`. */
export function joined(ranges: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const { start, end } of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && start < last.end) last.end = Math.max(last.end, end);
    else out.push({ start, end });
  }
  return out;
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
  const tokenizers: Span[] = [];
  if (TOKEN.test(source)) {
    for (const n of root.findAll({ rule: { any: TOKEN_KINDS[py ? "py" : "js"].map((kind) => ({ kind })) } })) {
      if (!/^[\w.$]*token[\w.$]*$/i.test(short(n.field(TOKEN_FIELDS[String(n.kind())]!)))) continue;
      const { start, end } = n.range();
      if (start.index >= (tokenizers.at(-1)?.end ?? -1)) tokenizers.push({ start: start.index, end: end.index });
    }
  }
  const kinds = py ? ["string"] : ["string", "template_string"];
  const found = root.findAll({ rule: { any: kinds.map((kind) => ({ kind })) } }).flatMap((n) => {
    const model = stringText(n);
    return model !== undefined && names.has(model) ? [{ start: n.range().start.index, model }] : [];
  });
  /** Index of the first model name starting at or after `at`. */
  const next = (at: number) => {
    let [lo, hi] = [0, found.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (found[mid]!.start < at) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  // Walk down to each model name, keeping its ancestors, into branches that hold one.
  const out: ModelValue[] = [];
  const up: Frame[] = [];
  const todo = [{ node: root, depth: 0, start: 0 }];
  let [textLine, text] = [-1, ""];
  while (todo.length > 0) {
    const { node, depth, start } = todo.pop()!;
    up.length = depth;
    const name = found[next(start)];
    if (name?.start === start && kinds.includes(String(node.kind()))) {
      const range = node.range();
      if (isModelValue(node, up) && !inside(tokenizers, start, range.end.index)) {
        const { line, column } = range.start;
        // Trimmed once per line: a long line can hold many values.
        if (line !== textLine) [textLine, text] = [line, lines[line]!.trim().slice(0, 200)];
        out.push({ line: line + 1, column: column + 1, text, span: { start, end: range.end.index }, model: name.model });
      }
      continue;
    }
    const kids = node.namedChildren();
    up.push({ node, kids });
    for (let k = kids.length - 1; k >= 0; k--) {
      const { start, end } = kids[k]!.range();
      if ((found[next(start.index)]?.start ?? Infinity) < end.index) todo.push({ node: kids[k]!, depth: depth + 1, start: start.index });
    }
  }
  return out;
}
