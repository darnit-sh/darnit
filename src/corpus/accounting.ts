import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { ChangeRecord } from "../records/schema.js";
import { covers, ENDPOINT_GONE } from "./candidates.js";
import type { ChangeEntry } from "./oasdiff.js";

/**
 * A deprecation marked in the spec, or a removal the corpus history recorded, under a stable readable key, with
 * what a record must cover to cover it: an operation, a request field (of a schema or on an endpoint), a whole
 * request schema, or an enum value of a field.
 */
export type Item = {
  key: string;
  method?: string | undefined;
  path?: string | undefined;
  schema?: string | undefined;
  field?: string | undefined;
  value?: string | undefined;
};

/** A removal as the corpus run logs it: an oasdiff entry and the day it was seen. */
export const RemovalSchema = z.object({ observedAt: z.iso.date(), id: z.string(), text: z.string(), operation: z.string().optional(), path: z.string().optional() });
export type Removal = z.infer<typeof RemovalSchema>;

/** The removals among one corpus run's oasdiff entries, as the corpus logs them. */
export const removalsFrom = (entries: ChangeEntry[], observedAt: string): Removal[] =>
  entries
    .filter((e) => e.id.includes("removed"))
    .map((e) => ({ observedAt, id: e.id, ...(e.operation ? { operation: e.operation } : {}), ...(e.path ? { path: e.path } : {}), text: e.text }));

/** A file's text, or "" when it does not exist; any other failure throws. */
export const readOptional = (file: string, read = (f: string) => readFile(f, "utf8")) =>
  read(file).catch((err: NodeJS.ErrnoException) => (err.code === "ENOENT" ? "" : Promise.reject(err)));

/** Appends to a corpus removals log, starting one when there is none. A log that cannot be read is never replaced. */
export async function appendRemovals(file: string, removed: Removal[], read?: (f: string) => Promise<string>): Promise<void> {
  const log = RemovalSchema.array().parse(JSON.parse((await readOptional(file, read)) || "[]"));
  await writeFile(file, `${JSON.stringify([...log, ...removed], null, 2)}\n`);
}

/**
 * One entry of packs/<vendor>/not-covered.yaml: items with no record, and why, or the record they still need
 * and, when OpenAI gives one, the date it matters by.
 */
export const NotCoveredSchema = z
  .array(
    z
      .object({ items: z.array(z.string().min(1)).min(1), reason: z.string().min(1).optional(), "needs-record": z.string().min(1).optional(), date: z.iso.date().optional() })
      .strict()
      .refine((e) => !e.reason !== !e["needs-record"], "each entry gives either a reason or needs-record")
      .refine((e) => !e.date || e["needs-record"], "only a needs-record entry takes a date"),
  )
  .superRefine((entries, ctx) => {
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
const refName = (n: unknown) => (isNode(n) && typeof n.$ref === "string" ? COMPONENT.exec(n.$ref)?.[2] : undefined);

/** What a record has to cover for the item a key names, read from the key's own words. */
function target(label: string[], value?: string): Omit<Item, "key"> {
  const [first, second, third, fourth] = label;
  const prop = label.lastIndexOf("property");
  if (value !== undefined) return { value, ...(prop > 0 ? { field: label[prop + 1] } : first === "schema" ? { schema: second } : {}) };
  if (first === "schema" && label.length === 2) return { schema: second };
  if (first === "schema" && third === "property" && label.length === 4) return { schema: second, field: fourth };
  if (label.length === 2 && METHODS.has(first!.toLowerCase())) return { method: first, path: second };
  return {};
}

/**
 * Everything the spec marks `deprecated: true`, plus enum values listed under x-openai-enum-deprecations.
 * Keys read like "schema CreateImageRequest property user" or "POST /assistants"; allOf parts merge
 * into their schema, and a oneOf or anyOf variant is named by its $ref when it has one.
 */
export function deprecatedItems(spec: unknown): Item[] {
  const items = new Map<string, Item>();
  const add = (label: string[], value?: string) => {
    const key = label.join(" ");
    if (!items.has(key)) items.set(key, { key, ...target(label, value) });
  };
  // A YAML alias can make a node its own descendant; on the way down it is visited once.
  const onPath = new WeakSet<object>();
  const walk = (node: unknown, label: string[], within?: string): void => {
    if (!isNode(node) || onPath.has(node)) return;
    onPath.add(node);
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
    onPath.delete(node);
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

/**
 * Each removal under its full identity: endpoint, oasdiff id, every name the entry quotes, and its media type, as in
 * "GET /files request-parameter-removed `query` `limit`" or "POST /images/edits request-property-enum-value-removed `auto` `background`".
 */
export function removalItems(removals: Removal[]): Item[] {
  const items = new Map<string, Item>();
  for (const r of removals) {
    const names = [...r.text.matchAll(/`([^`]*)`/g)].map((m) => m[1]!);
    const media = /\(media type: ([^)]*)\)/.exec(r.text)?.[1];
    const endpoint = r.operation && r.path ? `${r.operation} ${r.path}` : undefined;
    const key = [endpoint, r.id, ...names.map((n) => `\`${n}\``), media && `(${media})`].filter(Boolean).join(" ");
    const name = r.id === "request-property-removed" ? names[0] : r.id === "request-parameter-removed" ? names.at(-1) : undefined;
    const field = endpoint && name && /^[^/\s]+$/.test(name) ? name : undefined;
    const at = endpoint && (field || ENDPOINT_GONE.test(r.id)) ? { method: r.operation, path: r.path } : {};
    if (!items.has(key)) items.set(key, { key, ...at, field });
  }
  return [...items.values()];
}

/** Each operation with a request body, and the component schemas that body reaches through $refs. */
export function requestSchemas(spec: unknown): { method: string; path: string; names: Set<string> }[] {
  const out: { method: string; path: string; names: Set<string> }[] = [];
  const components = isNode(spec) && isNode(spec.components) ? spec.components : {};
  for (const [path, ops] of Object.entries(isNode(spec) && isNode(spec.paths) ? spec.paths : {})) {
    for (const [m, op] of Object.entries(isNode(ops) ? ops : {})) {
      if (!METHODS.has(m) || !isNode(op)) continue;
      const names = new Set<string>();
      const seen = new WeakSet<object>();
      const stack: unknown[] = [op.requestBody];
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
      if (names.size > 0) out.push({ method: m.toUpperCase(), path, names });
    }
  }
  return out;
}

/** For each component schema, the names of the properties whose value can be it: by $ref, directly or through anyOf, oneOf or allOf. */
function holders(spec: unknown): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const schemas = isNode(spec) && isNode(spec.components) && isNode(spec.components.schemas) ? spec.components.schemas : {};
  const valueOf = (node: unknown, found: Set<string>): Set<string> => {
    if (!isNode(node)) return found;
    const name = typeof node.$ref === "string" && node.$ref.startsWith("#/components/schemas/") ? refName(node) : undefined;
    if (name !== undefined && Object.hasOwn(schemas, name) && !found.has(name)) {
      found.add(name);
      valueOf(schemas[name], found);
    }
    for (const k of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(node[k])) for (const part of node[k] as unknown[]) valueOf(part, found);
    return found;
  };
  const seen = new WeakSet<object>();
  const stack: unknown[] = [spec];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!isNode(n) || seen.has(n)) continue;
    seen.add(n);
    if (isNode(n.properties))
      for (const [field, value] of Object.entries(n.properties)) for (const s of valueOf(value, new Set())) out.set(s, (out.get(s) ?? new Set()).add(field));
    for (const child of Object.values(n)) stack.push(child);
  }
  return out;
}

export type Open = { key: string; proposal: string; date?: string | undefined };

export type Accounting = {
  deprecated: number;
  removals: number;
  /** Item key to the ids of the records that cover it. */
  covered: Map<string, string[]>;
  reasons: string[];
  needsRecord: Open[];
  unaccounted: string[];
  /** Entries naming an item that is no longer in the spec or the removals log. */
  stale: string[];
  /** Entries naming an item a record already covers. */
  redundant: { key: string; ids: string[] }[];
};

/**
 * Joins each item to the records that cover it or to its not-covered entry. An operation is covered by a record for
 * its endpoint (or its SDK call, from `symbols`) with no fields. A request schema, or one of its properties, is
 * covered only when every operation whose request reaches the schema has such a record, for that field when there
 * is one. A deprecated enum value is covered when a record has a pattern setting a field that can hold it to that
 * exact value.
 */
export function account(input: {
  vendor: string;
  spec: unknown;
  removals: Removal[];
  records: ChangeRecord[];
  notCovered: NotCovered;
  /** "POST /chat/completions" -> "chat.completions.create", as in vendors.yml */
  symbols?: Record<string, string> | undefined;
}): Accounting {
  const { vendor, spec, records } = input;
  const deprecated = deprecatedItems(spec);
  const removals = removalItems(input.removals);
  let reach: ReturnType<typeof requestSchemas> | undefined;
  let held: Map<string, Set<string>> | undefined;
  const coversOp = (r: ChangeRecord, method: string, path: string, field: string | undefined) =>
    covers(r, vendor, path, field, method, input.symbols?.[`${method} ${path}`]);
  const coveredBy = (item: Item): ChangeRecord[] => {
    if (item.value !== undefined) {
      held ??= holders(spec);
      const fields = item.field !== undefined ? [item.field] : [...(held.get(item.schema ?? "") ?? [])];
      const sets = (f: string) => [`${f}: "${item.value}"`, `${f}: '${item.value}'`, `${f}="${item.value}"`, `${f}='${item.value}'`];
      return records.filter(
        (r) =>
          r.vendor === vendor &&
          fields.some((f) => Object.values(r.detection.astGrepPatterns).some((ps) => ps?.some((p) => sets(f).some((s) => p.context.includes(s))))),
      );
    }
    if (item.method !== undefined && item.path !== undefined) return records.filter((r) => coversOp(r, item.method!, item.path!, item.field));
    if (item.schema === undefined) return [];
    reach ??= requestSchemas(spec);
    const found = new Set<ChangeRecord>();
    for (const op of reach.filter((o) => o.names.has(item.schema!))) {
      const these = records.filter((r) => coversOp(r, op.method, op.path, item.field));
      if (these.length === 0) return [];
      for (const r of these) found.add(r);
    }
    return [...found];
  };

  const entries = new Map<string, NotCovered[number]>();
  for (const e of input.notCovered) for (const key of e.items) entries.set(key, e);
  const result: Accounting = { deprecated: deprecated.length, removals: removals.length, covered: new Map(), reasons: [], needsRecord: [], unaccounted: [], stale: [], redundant: [] };
  const known = new Set<string>();
  for (const item of [...deprecated, ...removals]) {
    known.add(item.key);
    const ids = coveredBy(item).map((r) => r.id);
    const entry = entries.get(item.key);
    if (ids.length > 0) {
      result.covered.set(item.key, ids);
      if (entry) result.redundant.push({ key: item.key, ids });
    } else if (entry?.reason) result.reasons.push(item.key);
    else if (entry?.["needs-record"]) result.needsRecord.push({ key: item.key, proposal: entry["needs-record"], date: entry.date });
    else result.unaccounted.push(item.key);
  }
  result.stale = [...entries.keys()].filter((k) => !known.has(k));
  return result;
}

/** Open items grouped by proposal, soonest date first and undated last; `past` when the date is before `today`. */
export function openItems(open: Open[], today: string): { proposal: string; date?: string | undefined; past: boolean; keys: string[] }[] {
  const groups = new Map<string, { proposal: string; date?: string | undefined; past: boolean; keys: string[] }>();
  for (const o of open) {
    const id = `${o.date ?? ""}\n${o.proposal}`;
    const group = groups.get(id) ?? { proposal: o.proposal, date: o.date, past: o.date !== undefined && o.date < today, keys: [] };
    group.keys.push(o.key);
    groups.set(id, group);
  }
  const order = (g: { date?: string | undefined }) => g.date ?? "￿";
  return [...groups.values()].sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
}
