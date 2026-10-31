import { createHash } from "node:crypto";
import { parse } from "yaml";

export type Schema = {
  $ref?: string;
  type?: string;
  description?: string;
  deprecated?: boolean;
  properties?: Record<string, Schema>;
  allOf?: Schema[];
};

type Operation = { operationId?: string; requestBody?: { content?: Record<string, { schema?: Schema }> } };

export type Spec = {
  paths?: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Schema> };
};

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export const parseSpec = (text: string) => parse(text) as Spec;

const LOCAL = "#/components/schemas/";
const resolved = new WeakMap<Spec, Map<string, Schema | undefined>>();

/**
 * The schema a $ref chain ends at. Only the spec's own components count, and a cycle resolves to
 * nothing. Each schema name is resolved once per spec, so any number of lookups stays linear.
 */
function resolve(spec: Spec, schema: Schema | undefined): Schema | undefined {
  let memo = resolved.get(spec);
  if (!memo) resolved.set(spec, (memo = new Map<string, Schema | undefined>()));
  const chain = new Set<string>();
  while (schema?.$ref) {
    const ref: unknown = schema.$ref;
    const name = typeof ref === "string" && ref.startsWith(LOCAL) ? ref.slice(LOCAL.length) : undefined;
    if (name !== undefined && memo.has(name)) {
      schema = memo.get(name);
      break;
    }
    if (name === undefined || chain.has(name)) {
      schema = undefined;
      break;
    }
    chain.add(name);
    const schemas = spec.components?.schemas;
    schema = schemas && Object.hasOwn(schemas, name) ? schemas[name] : undefined;
  }
  for (const name of chain) memo.set(name, schema);
  return schema;
}

/** One property of an operation's JSON request body; $ref resolved, allOf flattened one level. */
export function requestProperty(spec: Spec, method: string, path: string, field: string): Schema | undefined {
  const op = spec.paths?.[path]?.[method.toLowerCase()];
  const body = resolve(spec, op?.requestBody?.content?.["application/json"]?.schema);
  // Later allOf parts override earlier ones and the body's own properties.
  const parts = [body, ...(Array.isArray(body?.allOf) ? body.allOf : []).map((p) => resolve(spec, p))].reverse();
  const own = parts.find((p) => p?.properties && Object.hasOwn(p.properties, field))?.properties?.[field];
  return resolve(spec, own) ?? own;
}

/** The ids in a schema's own enum and in the enums of its anyOf parts, not in its properties. */
function enumIds(schema: unknown, out: Set<string>): void {
  if (!schema || typeof schema !== "object") return;
  const s = schema as { enum?: unknown; anyOf?: unknown };
  if (Array.isArray(s.enum)) for (const v of s.enum as unknown[]) if (typeof v === "string") out.add(v);
  if (Array.isArray(s.anyOf)) for (const p of s.anyOf as unknown[]) enumIds(p, out);
}

/** Every model id the spec lists: the enums of each `model` property and of the schemas of model ids, such as ModelIdsShared. */
export function modelIds(spec: Spec): Set<string> {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "model") enumIds(value, out);
      walk(value);
    }
  };
  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
    if (/ModelIds|SupportedModels$/.test(name)) enumIds(schema, out);
    walk(schema);
  }
  return out;
}
