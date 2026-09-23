import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseChangeRecord, type ChangeRecord } from "../records/schema.js";
import type { ChangeEntry } from "./oasdiff.js";
import { requestProperties, type Spec } from "./spec.js";

export type VendorConfig = {
  spec: string;
  /** "POST /chat/completions" -> "chat.completions.create"; gates detection to the SDK call */
  symbols?: Record<string, string>;
};

export type Candidate = {
  record: ChangeRecord;
  /** "<vendor>/<date>-<slug>" under packs/ */
  dir: string;
  /** rules and fixtures, relative to dir; change.json is written from record */
  files: Record<string, string>;
};

export type Derivation = { candidates: Candidate[]; ignored: Record<string, number>; unmapped: string[] };

const KIND: Record<string, ChangeRecord["kind"]> = {
  "request-property-deprecated": "deprecation",
  "request-property-removed": "breaking",
  "request-parameter-removed": "breaking",
  "endpoint-deprecated": "deprecation",
};
const ENDPOINT_GONE = /^(api|endpoint)(-path)?-removed/;

const REPLACEMENT = /(?:in favou?r of|replaced by|use)\s+`?([A-Za-z_][A-Za-z0-9_]*)`?/i;

const kebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const sentences = (s: string) => s.replace(/\s+/g, " ").trim().split(/(?<=\.)\s/);
const firstSentence = (s: string) => sentences(s)[0]!.slice(0, 200);
// the sentence that states the deprecation, when there is one
const quote = (s: string) => (sentences(s).find((x) => /deprecat|in favou?r of|replaced by/i.test(x)) ?? firstSentence(s)).slice(0, 200);
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function renameRule(lang: "js" | "py", id: string, field: string, replacement: string, symbol: string): string {
  const [pattern, selector, obj, args, call, fix] =
    lang === "js"
      ? [`({ ${field}: $V })`, "pair", "object", "arguments", "call_expression", `${replacement}: $V`]
      : [`f(${field}=$V)`, "keyword_argument", "argument_list", "argument_list", "call", `${replacement}=$V`];
  const chain =
    lang === "js"
      ? `  inside:\n    kind: ${obj}\n    inside:\n      kind: ${args}\n      inside:\n        kind: ${call}\n        has:\n          field: function\n          regex: '${escapeRegExp(symbol)}$'\n`
      : `  inside:\n    kind: ${args}\n    inside:\n      kind: ${call}\n      has:\n        field: function\n        regex: '${escapeRegExp(symbol)}$'\n`;
  return `id: ${id}-${lang}\nlanguage: ${lang === "js" ? "javascript" : "python"}\nrule:\n  pattern:\n    context: '${pattern}'\n    selector: ${selector}\n${chain}fix: '${fix}'\n`;
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
  const candidates: Candidate[] = [];

  const covered = (path: string, field: string | undefined) =>
    existing.some(
      (r) => r.vendor === vendor && r.surface.endpoints?.some((e) => e.endsWith(path)) && (field ? r.surface.fields?.includes(field) : !r.surface.fields?.length),
    );

  for (const e of entries) {
    const kind = KIND[e.id] ?? (ENDPOINT_GONE.test(e.id) ? "breaking" : undefined);
    const endpoint = e.operation && e.path ? `${e.operation} ${e.path}` : undefined;
    if (!kind || !endpoint || !e.path || !e.operation) {
      skip(e.id);
      continue;
    }
    const fieldLevel = e.id.startsWith("request-p");
    const field = fieldLevel ? e.text.match(/`([^`]+)`/)?.[1] : undefined;
    if (fieldLevel && (!field || field.includes("/"))) {
      skip(`${e.id} (nested property)`);
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
    if (covered(e.path, field)) {
      skip(`${e.id} (already recorded)`);
      continue;
    }

    const description = field ? (requestProperties(spec, e.operation, e.path)[field]?.description ?? "") : "";
    const replacement = kind === "deprecation" && field ? description.match(REPLACEMENT)?.[1] : undefined;
    const rename = replacement !== undefined && replacement !== field ? replacement : undefined;
    const where = symbol ?? endpoint;
    const gone = kind === "breaking";
    const slug = field
      ? rename
        ? `${kebab(field)}-to-${kebab(rename)}`
        : `${kebab(field)}-${gone ? "removed" : "deprecated"}`
      : `${kebab(endpoint)}-${gone ? "removed" : "deprecated"}`;
    const title = field
      ? rename
        ? `Rename ${field} to ${rename} on ${where}`
        : gone
          ? `Stop sending ${field} to ${where}`
          : `${field} is deprecated on ${where}`
      : `${endpoint} is ${gone ? "gone" : "deprecated"}`;
    const migration = rename
      ? `Rename ${field} to ${rename} on ${where} calls.`
      : field
        ? description
          ? firstSentence(description)
          : `${field} is ${gone ? "no longer accepted" : "deprecated"} on ${where}.`
        : `${endpoint} is ${gone ? "no longer served" : "deprecated"}; callers need the replacement endpoint.`;
    const dir = `${vendor}/${observedAt}-${slug}`;
    const patterns = field
      ? { js: [{ context: `({ ${field}: $V })`, selector: "pair" }], py: [{ context: `f(${field}=$V)`, selector: "keyword_argument" }] }
      : { js: [{ context: `$C.${symbol}($$$ARGS)`, selector: "call_expression" }], py: [{ context: `$C.${symbol}($$$ARGS)`, selector: "call" }] };

    const record = parseChangeRecord(
      {
        id: `${vendor}:${observedAt}:${slug}`,
        title: title.slice(0, 100),
        status: "candidate",
        vendor,
        announcedAt: observedAt,
        kind,
        surface: { endpoints: [e.path], ...(symbol ? { sdkSymbols: [symbol] } : {}), ...(field ? { fields: [field] } : {}) },
        classification: rename && symbol ? "mechanical" : "semantic",
        sources: [{ url: config.spec, quoteId: `${endpoint}${field ? ` ${field}` : ""}: ${quote(description) || e.text}` }],
        detection: { astGrepPatterns: patterns },
        ...(rename && symbol ? { fix: { rulePackPath: `packs/${dir}/` } } : {}),
        notes: {
          migration,
          citationQuality: "Derived from the vendor's OpenAPI specification; the date is when darnit observed the change there, not when the vendor announced it.",
        },
      },
      `${dir}/change.json`,
    );

    const call = symbol ?? "call";
    const js = field ? `export const r = client.${call}({ ${field}: 1 });\n` : `export const r = client.${call}({});\n`;
    const py = field ? `r = client.${call}(${field}=1)\n` : `r = client.${call}()\n`;
    const files: Record<string, string> = {
      "fixtures/basic/before/app.js": js,
      "fixtures/basic/before/app.py": py,
      "fixtures/basic/after/app.js": rename && symbol ? js.replace(`${field}:`, `${rename}:`) : js,
      "fixtures/basic/after/app.py": rename && symbol ? py.replace(`${field}=`, `${rename}=`) : py,
      "fixtures/basic/expected.json": `${JSON.stringify({ note: "Generated from the vendor's OpenAPI specification.", matches: { "before/app.js": 1, "before/app.py": 1 } }, null, 2)}\n`,
    };
    if (rename && symbol && field) {
      const ruleId = `${vendor}-${slug}`;
      files["rules/js/01-rename.yml"] = renameRule("js", ruleId, field, rename, symbol);
      files["rules/py/01-rename.yml"] = renameRule("py", ruleId, field, rename, symbol);
    }
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
