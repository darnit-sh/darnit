import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseChangeRecord, type ChangeRecord } from "../records/schema.js";
import type { ChangeEntry } from "./oasdiff.js";
import { requestProperty, type Spec } from "./spec.js";

export type VendorConfig = {
  spec: string;
  /** "POST /chat/completions" -> "chat.completions.create"; gates detection to the SDK call */
  symbols?: Record<string, string>;
};

export type Candidate = {
  record: ChangeRecord;
  /** "<vendor>/<date>-<slug>" under packs/ */
  dir: string;
  /** Fixtures, relative to dir; change.json is written from record. */
  files: Record<string, string>;
};

export type Derivation = { candidates: Candidate[]; ignored: Record<string, number>; unmapped: string[] };

const KIND: Record<string, ChangeRecord["kind"]> = {
  "request-property-deprecated": "deprecation",
  "request-property-removed": "breaking",
  "request-parameter-removed": "breaking",
  "endpoint-deprecated": "deprecation",
};
export const ENDPOINT_GONE = /^(api|endpoint)(-path)?-removed/;
// Spec text lands in ast-grep patterns, fixtures and the corpus pull request,
// so only plain names and paths get through; anything else is counted in `ignored`, never echoed.
// The caps keep folder names short (longest in OpenAI's spec: a 35-character name, an 82-character path).
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// Python's keyword.kwlist: `f(from=$V)` is not valid Python, and ast-grep rejects it as a pattern.
const PY_KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(
    " ",
  ),
);
const METHOD = /^[A-Z]{1,10}$/;
const PATH = /^\/[\w/{}?=-]{0,199}$/;
// Greedy, so a name with a backtick in it is read whole and then fails IDENTIFIER.
const FIELD = /request (?:property|parameter) `(.*)`/s;

// Only explicit phrasings; a bare "use X" would turn prose like "Use this to…" into a rename.
const REPLACEMENT =
  /(?:in favou?r of|replaced by)\s+`?([A-Za-z_][A-Za-z0-9_]*)`?|use\s+`([A-Za-z_][A-Za-z0-9_]*)`\s+instead/i;

const kebab = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const sentences = (s: string) =>
  s
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=\.)\s/);
const firstSentence = (s: string) => sentences(s)[0]!.slice(0, 200);
// The sentence that states the deprecation, when there is one.
const quote = (s: string) =>
  (sentences(s).find((x) => /deprecat|in favou?r of|replaced by/i.test(x)) ?? firstSentence(s)).slice(0, 200);

// "POST /v1/chat/completions" or "/v1/chat/completions" as its method, if any, and its path without the
// /v1 prefix, so "/completions" is not "/chat/completions". A query stays: "/responses?beta=true" is the spec's
// separate beta surface, which a record for "/responses" does not cover.
const endpointOf = (e: string) => {
  const m = /^([A-Z]+) (.*)$/.exec(e);
  return { method: m?.[1], path: (m?.[2] ?? e).replace(/^\/v1(?=\/|$)/, "") };
};

type Setting = { key: string; any: boolean; value?: string | undefined };
const settingsMemo = new WeakMap<ChangeRecord, Setting[]>();
/**
 * Every key a record's patterns set: to any value (a metavariable such as `$V`, or a bare `{ key }`), to a string
 * (`value`), or to another literal (`true`, `1`, `None`, an object), which is only that literal. Keys are whole names:
 * `image_size: "x"` sets `image_size`, never `size`. Each word is tried once, from its start.
 */
export function settingsOf(r: ChangeRecord): Setting[] {
  let found = settingsMemo.get(r);
  if (found) return found;
  found = [];
  for (const ps of Object.values(r.detection.astGrepPatterns))
    for (const { context } of ps ?? []) {
      for (const m of context.matchAll(/["']?(?<!\w)\d*([A-Za-z_]\w*)["']?\s*[:=]\s*(\$|"([^"]*)"|'([^']*)')?/g))
        found.push({ key: m[1]!, any: m[2] === "$", value: m[3] ?? m[4] });
      for (const m of context.matchAll(/\{\s*([A-Za-z_]\w*)\s*\}/g)) found.push({ key: m[1]!, any: true });
    }
  settingsMemo.set(r, found);
  return found;
}

/**
 * Whether a record's surface names an operation: its endpoint (with its method, when both give one), or its SDK call
 * as detection matches one: the call ends with one of the record's symbols, so `beta.responses.create` is a
 * `responses.create` call.
 */
export function namesOperation(r: ChangeRecord, path: string, method?: string, symbol?: string): boolean {
  const want = endpointOf(path);
  return (
    !!r.surface.endpoints?.some((e) => {
      const have = endpointOf(e);
      return have.path === want.path && (!have.method || !method || have.method === method);
    }) ||
    (symbol !== undefined && !!r.surface.sdkSymbols?.some((s) => symbol.endsWith(s)))
  );
}

/**
 * Whether a record covers `field` on `path`, or the whole endpoint when there is no field, on `method` when both name
 * one; with `symbol`, the operation's SDK call, a record that lists that call covers it too. A field needs a record
 * naming it in its surface and finding it with any value: one that finds `model: "dall-e-2"` covers that value, never
 * the field. An endpoint needs a record with no fields whose patterns set no key, so it finds every call.
 */
export function covers(
  r: ChangeRecord,
  vendor: string,
  path: string,
  field: string | undefined,
  method?: string,
  symbol?: string,
): boolean {
  const settings = settingsOf(r);
  return (
    r.vendor === vendor &&
    (field
      ? !!r.surface.fields?.includes(field) && settings.some((s) => s.key === field && s.any)
      : !r.surface.fields?.length && settings.length === 0) &&
    namesOperation(r, path, method, symbol)
  );
}

export function deriveCandidates(input: {
  vendor: string;
  config: VendorConfig;
  entries: ChangeEntry[];
  spec: Spec;
  existing: ChangeRecord[];
  /** YYYY-MM-DD the diff was observed */
  observedAt: string;
}): Derivation {
  const { vendor, config, entries, spec, existing, observedAt } = input;
  const ignored: Record<string, number> = {};
  const skip = (why: string) => (ignored[why] = (ignored[why] ?? 0) + 1);
  const unmapped = new Set<string>();
  const seen = new Set<string>();
  // The same field changing on several endpoints is one record with several endpoints.
  type Draft = {
    slug: string;
    kind: ChangeRecord["kind"];
    field?: string | undefined;
    rename?: string | undefined;
    description: string;
    text: string;
    endpoints: string[];
    paths: string[];
    symbols: string[];
  };
  const drafts = new Map<string, Draft>();

  for (const e of entries) {
    const kind = KIND[e.id] ?? (ENDPOINT_GONE.test(e.id) ? "breaking" : undefined);
    const endpoint = e.operation && e.path ? `${e.operation} ${e.path}` : undefined;
    if (!kind || !endpoint || !e.path || !e.operation) {
      skip(e.id);
      continue;
    }
    const fieldLevel = e.id.startsWith("request-p");
    const field = fieldLevel ? e.text.match(FIELD)?.[1] : undefined;
    if (fieldLevel && (!field || field.includes("/"))) {
      skip(`${e.id} (nested property)`);
      continue;
    }
    if (!METHOD.test(e.operation)) {
      skip(`${e.id} (method is not a plain HTTP method)`);
      continue;
    }
    if (!PATH.test(e.path)) {
      skip(`${e.id} (endpoint is not a plain path)`);
      continue;
    }
    if (field !== undefined && !IDENTIFIER.test(field)) {
      skip(`${e.id} (field name is not a plain identifier, ${endpoint})`);
      continue;
    }
    const symbol = config.symbols?.[endpoint];
    if (!symbol) unmapped.add(endpoint);
    if (!symbol && !fieldLevel) {
      skip(`${e.id} (no symbol for ${endpoint})`);
      continue;
    }
    const key = `${endpoint} ${field ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (existing.some((r) => covers(r, vendor, e.path!, field))) {
      skip(`${e.id} (already recorded)`);
      continue;
    }

    const description = field ? (requestProperty(spec, e.operation, e.path, field)?.description ?? "") : "";
    const m = kind === "deprecation" && field ? description.match(REPLACEMENT) : null;
    const replacement = m?.[1] ?? m?.[2];
    const rename =
      replacement !== undefined && replacement !== field && IDENTIFIER.test(replacement) ? replacement : undefined;
    const gone = kind === "breaking";
    const slug = field
      ? rename
        ? `${kebab(field)}-to-${kebab(rename)}`
        : `${kebab(field)}-${gone ? "removed" : "deprecated"}`
      : `${kebab(endpoint)}-${gone ? "removed" : "deprecated"}`;
    // Keyed by the exact name: names that differ only in case or punctuation share a slug, not a record.
    const id = JSON.stringify([field ?? endpoint, rename, gone]);
    const draft = drafts.get(id) ?? {
      slug,
      kind,
      field,
      rename,
      description,
      text: e.text,
      endpoints: [],
      paths: [],
      symbols: [],
    };
    draft.endpoints.push(endpoint);
    draft.paths.push(e.path);
    if (symbol && !draft.symbols.includes(symbol)) draft.symbols.push(symbol);
    drafts.set(id, draft);
  }

  const candidates: Candidate[] = [];
  const slugs = new Set<string>();
  for (const d of drafts.values()) {
    let slug = d.slug;
    for (let n = 2; slugs.has(slug); n++) slug = `${d.slug}-${n}`;
    slugs.add(slug);
    const { kind, field, rename, description } = d;
    const symbol = d.symbols[0];
    const endpoint = d.endpoints[0]!;
    const gone = kind === "breaking";
    const where = d.symbols.length > 0 ? d.symbols.join(", ") : d.endpoints.join(", ");
    const title = field
      ? gone
        ? `Stop sending ${field} to ${where}`
        : `${field} is deprecated on ${where}`
      : `${endpoint} is ${gone ? "gone" : "deprecated"}`;
    // A deprecated field still works and the replacement may be newer than the SDK a repo pins, so it is
    // reported, not rewritten. A rename can come back behind fix.requires once the SDK versions are known.
    const migration = rename
      ? `${field} is deprecated in favor of ${rename}. Before renaming, check that your SDK version accepts ${rename} on ${where} calls.`
      : field
        ? description
          ? firstSentence(description)
          : `${field} is ${gone ? "no longer accepted" : "deprecated"} on ${where}.`
        : `${endpoint} is ${gone ? "no longer served" : "deprecated"}; callers need the replacement endpoint.`;
    const dir = `${vendor}/${observedAt}-${slug}`;
    const pyKeyword = field !== undefined && PY_KEYWORDS.has(field);
    const patterns = field
      ? {
          js: [
            { context: `({ ${field}: $V })`, selector: "pair" },
            { context: `({ ${field} })`, selector: "shorthand_property_identifier" },
            { context: `({ "${field}": $V })`, selector: "pair" },
            { context: `({ '${field}': $V })`, selector: "pair" },
          ],
          py: [
            ...(pyKeyword ? [] : [{ context: `f(${field}=$V)`, selector: "keyword_argument" }]),
            { context: `{"${field}": $V}`, selector: "pair" },
            { context: `{'${field}': $V}`, selector: "pair" },
          ],
        }
      : {
          js: [{ context: `$C.${symbol}($$$ARGS)`, selector: "call_expression" }],
          py: [{ context: `$C.${symbol}($$$ARGS)`, selector: "call" }],
        };

    const record = parseChangeRecord(
      {
        id: `${vendor}:${observedAt}:${slug}`,
        title: title.slice(0, 100),
        status: "candidate",
        vendor,
        announcedAt: observedAt,
        kind,
        surface: {
          endpoints: d.paths,
          ...(d.symbols.length > 0 ? { sdkSymbols: d.symbols } : {}),
          ...(field ? { fields: [field] } : {}),
        },
        classification: "semantic",
        sources: [
          { url: config.spec, quoteId: `${endpoint}${field ? ` ${field}` : ""}: ${quote(description) || d.text}` },
        ],
        detection: { astGrepPatterns: patterns },
        notes: {
          migration,
          ...(pyKeyword
            ? {
                edgeCases: [
                  `${field} is a Python keyword, so Python code can only send it in a dict; only quoted keys are detected there.`,
                ],
              }
            : {}),
          citationQuality:
            "Derived from the vendor's OpenAPI specification; the date is when darnit observed the change there, not when the vendor announced it.",
        },
      },
      `${dir}/change.json`,
    );

    const call = symbol ?? "call";
    const js = field ? `export const r = client.${call}({ ${field}: 1 });\n` : `export const r = client.${call}({});\n`;
    const py = field
      ? `r = client.${call}(${pyKeyword ? `**{"${field}": 1}` : `${field}=1`})\n`
      : `r = client.${call}()\n`;
    const files: Record<string, string> = {
      "fixtures/basic/before/app.js": js,
      "fixtures/basic/before/app.py": py,
      "fixtures/basic/after/app.js": js,
      "fixtures/basic/after/app.py": py,
      "fixtures/basic/expected.json": `${JSON.stringify({ note: "Generated from the vendor's OpenAPI specification.", matches: { "before/app.js": 1, "before/app.py": 1 } }, null, 2)}\n`,
    };
    candidates.push({ record, dir, files });
  }
  return { candidates, ignored, unmapped: [...unmapped].sort() };
}

export async function writeCandidate(packsDir: string, c: Candidate): Promise<string> {
  const dir = join(packsDir, c.dir);
  const all = { "change.json": `${JSON.stringify(c.record, null, 2)}\n`, ...c.files };
  for (const [rel, text] of Object.entries(all)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}
