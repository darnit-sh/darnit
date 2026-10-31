import { z } from "zod";
import type { ChangeRecord } from "../records/schema.js";
import { covers, ENDPOINT_GONE } from "./candidates.js";
import type { ChangeEntry } from "./oasdiff.js";

/** A deprecation marked in the spec, or a removal the corpus history recorded, under a stable readable key. */
export type Item = { key: string; field?: string | undefined; schema?: string | undefined; path?: string | undefined; value?: string | undefined };

/** A removal as the corpus run logs it: an oasdiff entry and the day it was seen. */
export const RemovalSchema = z.object({ observedAt: z.iso.date(), id: z.string(), text: z.string(), operation: z.string().optional(), path: z.string().optional() });
export type Removal = z.infer<typeof RemovalSchema>;

/** The removals among one corpus run's oasdiff entries, as the corpus logs them. */
export const removalsFrom = (entries: ChangeEntry[], observedAt: string): Removal[] =>
  entries
    .filter((e) => e.id.includes("removed"))
    .map((e) => ({ observedAt, id: e.id, ...(e.operation ? { operation: e.operation } : {}), ...(e.path ? { path: e.path } : {}), text: e.text }));

/** One entry of packs/<vendor>/not-covered.yaml: items with no record, and why, or the record they still need. */
export const NotCoveredSchema = z.array(
  z
    .object({ items: z.array(z.string().min(1)).min(1), reason: z.string().min(1).optional(), "needs-record": z.string().min(1).optional() })
    .strict()
    .refine((e) => !e.reason !== !e["needs-record"], "each entry gives either a reason or needs-record"),
).superRefine((entries, ctx) => {
  const seen = new Set<string>();
  for (const key of entries.flatMap((e) => e.items)) {
    if (seen.has(key)) ctx.addIssue({ code: "custom", message: `${JSON.stringify(key)} is listed twice` });
    seen.add(key);
  }
});
export type NotCovered = z.infer<typeof NotCoveredSchema>;

type Node = Record<string, unknown>;
const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null;
const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const GROUPS = new Set(["properties", "allOf", "anyOf", "oneOf", "parameters"]);
const COMPONENT = /^#\/components\/([^/]+)\/([^/]+)$/;

/**
 * Everything the spec marks `deprecated: true`, plus enum values listed under x-openai-enum-deprecations.
 * Keys read like "schema CreateImageRequest property user" or "POST /assistants"; allOf parts merge
 * into their schema, and a oneOf or anyOf variant is named by its $ref when it has one.
 */
export function deprecatedItems(spec: unknown): Item[] {
  const items = new Map<string, Item>();
  const add = (label: string[], value?: string) => {
    const key = label.join(" ");
    const [kind, schema, prop, field] = label;
    const direct = label.length === 4 && kind === "schema" && prop === "property";
    if (!items.has(key)) items.set(key, { key, ...(direct && value === undefined ? { schema, field } : {}), value });
  };
  const walk = (node: unknown, label: string[], within?: string): void => {
    if (!isNode(node)) return;
    if (node.deprecated === true) add(label);
    const values = node["x-openai-enum-deprecations"];
    if (isNode(values)) for (const v of Object.keys(values)) add([...label, "enum", v], v);
    for (const [k, child] of Object.entries(node)) {
      if (within === "properties") walk(child, [...label, "property", k]);
      else if (within === "allOf") walk(child, label);
      else if (within === "anyOf" || within === "oneOf") walk(child, [...label, within, refName(child) ?? k]);
      else if (within === "parameters") walk(child, [...label, "parameter", isNode(child) && typeof child.name === "string" ? child.name : k]);
      else if (GROUPS.has(k)) walk(child, label, k);
      else walk(child, [...label, k]);
    }
  };
  for (const [k, v] of Object.entries(isNode(spec) ? spec : {})) {
    if ((k === "paths" || k === "webhooks") && isNode(v)) {
      for (const [p, ops] of Object.entries(v)) {
        const at = k === "paths" ? [p] : ["webhook", p];
        for (const [m, op] of Object.entries(isNode(ops) ? ops : {})) {
          if (METHODS.has(m)) walk(op, k === "paths" ? [m.toUpperCase(), p] : [...at, m.toUpperCase()]);
          else walk(op, m === "parameters" ? at : [...at, m], m === "parameters" ? m : undefined);
        }
      }
    } else if (k === "components" && isNode(v)) {
      for (const [t, group] of Object.entries(v)) for (const [n, s] of Object.entries(isNode(group) ? group : {})) walk(s, [t === "schemas" ? "schema" : t, n]);
    } else walk(v, [k]);
  }
  return [...items.values()];
}

const refName = (n: unknown) => (isNode(n) && typeof n.$ref === "string" ? COMPONENT.exec(n.$ref)?.[2] : undefined);

/** Each removal under a key like "POST /agents/sessions request-property-removed spend_control". */
export function removalItems(removals: Removal[]): Item[] {
  const items = new Map<string, Item>();
  for (const r of removals) {
    const subject = /`([^`]*)`/.exec(r.text)?.[1];
    const endpoint = r.operation && r.path ? `${r.operation} ${r.path}` : undefined;
    const key = [endpoint, r.id, subject].filter((s) => s !== undefined).join(" ");
    const field = endpoint && (r.id === "request-property-removed" || r.id === "request-parameter-removed") && subject && !subject.includes("/") ? subject : undefined;
    const path = endpoint && (field || ENDPOINT_GONE.test(r.id)) ? r.path : undefined;
    if (!items.has(key)) items.set(key, { key, field, path });
  }
  return [...items.values()];
}

/** For each path, the component schemas its request bodies reach through $refs. "/responses?beta=true" counts as "/responses". */
function requestSchemas(spec: unknown): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const components = isNode(spec) && isNode(spec.components) ? spec.components : {};
  for (const [path, ops] of Object.entries(isNode(spec) && isNode(spec.paths) ? spec.paths : {})) {
    const names = out.get(path.split("?")[0]!) ?? new Set<string>();
    const seen = new WeakSet<object>();
    const stack: unknown[] = Object.entries(isNode(ops) ? ops : {}).flatMap(([m, op]) => (METHODS.has(m) && isNode(op) ? [op.requestBody] : []));
    while (stack.length > 0) {
      const n = stack.pop();
      if (!isNode(n) || seen.has(n)) continue;
      seen.add(n);
      const ref = typeof n.$ref === "string" ? COMPONENT.exec(n.$ref) : null;
      const group = ref && Object.hasOwn(components, ref[1]!) ? components[ref[1]!] : undefined;
      if (ref && isNode(group) && Object.hasOwn(group, ref[2]!)) {
        if (ref[1] === "schemas") names.add(ref[2]!);
        stack.push(group[ref[2]!]);
      }
      for (const child of Object.values(n)) stack.push(child);
    }
    if (names.size > 0) out.set(path.split("?")[0]!, names);
  }
  return out;
}

export type Accounting = {
  deprecated: number;
  removals: number;
  /** Item key to the ids of the records that cover it. */
  covered: Map<string, string[]>;
  reasons: string[];
  needsRecord: { key: string; proposal: string }[];
  unaccounted: string[];
  /** Entries naming an item that is no longer in the spec or the removals log. */
  stale: string[];
  /** Entries naming an item a record already covers. */
  redundant: { key: string; ids: string[] }[];
};

/**
 * Joins each item to the records that cover it or to its not-covered entry. A schema property is
 * covered only when every endpoint whose request reaches the schema has a record for that field;
 * a deprecated enum value only when a record's patterns name that exact value.
 */
export function account(input: { vendor: string; spec: unknown; removals: Removal[]; records: ChangeRecord[]; notCovered: NotCovered }): Accounting {
  const { vendor, spec, records } = input;
  const deprecated = deprecatedItems(spec);
  const removals = removalItems(input.removals);
  let reach: Map<string, Set<string>> | undefined;
  const coveredBy = (item: Item): string[] => {
    const ids = new Set<string>();
    if (item.value !== undefined) {
      const quoted = [JSON.stringify(item.value), `'${item.value}'`];
      for (const r of records)
        if (r.vendor === vendor && Object.values(r.detection.astGrepPatterns).some((ps) => ps?.some((p) => quoted.some((q) => p.context.includes(q))))) ids.add(r.id);
      return [...ids];
    }
    if (item.field === undefined && item.path === undefined) return [];
    reach ??= requestSchemas(spec);
    const paths = item.schema !== undefined ? [...reach].filter(([, names]) => names.has(item.schema!)).map(([p]) => p) : [item.path!];
    for (const p of paths) {
      const found = records.filter((r) => covers(r, vendor, p, item.field));
      if (found.length === 0) return [];
      for (const r of found) ids.add(r.id);
    }
    return [...ids];
  };

  const entries = new Map<string, NotCovered[number]>();
  for (const e of input.notCovered) for (const key of e.items) entries.set(key, e);
  const result: Accounting = { deprecated: deprecated.length, removals: removals.length, covered: new Map(), reasons: [], needsRecord: [], unaccounted: [], stale: [], redundant: [] };
  const known = new Set<string>();
  for (const item of [...deprecated, ...removals]) {
    known.add(item.key);
    const ids = coveredBy(item);
    const entry = entries.get(item.key);
    if (ids.length > 0) {
      result.covered.set(item.key, ids);
      if (entry) result.redundant.push({ key: item.key, ids });
    } else if (entry?.reason) result.reasons.push(item.key);
    else if (entry?.["needs-record"]) result.needsRecord.push({ key: item.key, proposal: entry["needs-record"] });
    else result.unaccounted.push(item.key);
  }
  result.stale = [...entries.keys()].filter((k) => !known.has(k));
  return result;
}
