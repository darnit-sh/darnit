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

function resolve(spec: Spec, schema: Schema | undefined): Schema | undefined {
  if (!schema?.$ref) return schema;
  const name = schema.$ref.split("/").pop() ?? "";
  return resolve(spec, spec.components?.schemas?.[name]);
}

/** properties of an operation's JSON request body; $ref resolved, allOf flattened one level */
export function requestProperties(spec: Spec, method: string, path: string): Record<string, Schema> {
  const op = spec.paths?.[path]?.[method.toLowerCase()];
  const schema = resolve(spec, op?.requestBody?.content?.["application/json"]?.schema);
  if (!schema) return {};
  const props: Record<string, Schema> = { ...(schema.properties ?? {}) };
  for (const part of schema.allOf ?? []) Object.assign(props, resolve(spec, part)?.properties ?? {});
  return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, resolve(spec, v) ?? v]));
}
