import { z } from "zod";
import { TAIL_CHARS } from "./tests.js";

// `fix --prepare` writes this file in the job that runs the repository's code; `fix --publish` reads it in
// the job that holds the write token. Everything in it came from that code, so it is parsed strictly and the
// patch is recomputed, never applied.

export const PLAN_VERSION = 1 as const;
export const PLAN_FILE = "plan.json";

/** Caps: `plan` in bytes of the file, the rest in characters of each string or entries of each list. */
export const CAPS = { plan: 8 * 1024 * 1024, darnit: 64, groups: 64, files: 1000, path: 4096, patch: 1024 * 1024, command: 4096, output: TAIL_CHARS };

const capped = (max: number) => z.string().max(max, `over the cap of ${max} characters`);

/** A path inside the repository: relative, `/`-separated, with no `.`, `..` or `.git` part. */
const RelativePath = capped(CAPS.path).refine(
  (p) => !p.includes("\0") && p.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git"),
  "not a path inside the repository",
);

const OutcomeSchema = z.strictObject({
  command: capped(CAPS.command),
  passed: z.boolean(),
  attributed: z.enum(["change", "baseline"]).nullable(),
  notChecked: z.boolean(),
  timedOut: z.boolean(),
  output: capped(CAPS.output),
});

const INDEX = /^index [0-9a-f]{40}(?:[0-9a-f]{24})?\.\.[0-9a-f]{40}(?:[0-9a-f]{24})? 100(?:644|755)$/;
const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const BINARY = /^(?:literal|delta) \d+$/;
const BASE85 = /^[A-Za-z][0-9A-Za-z!#$%&()*+;<=>?@^_`{|}~-]+$/;

const C_ESCAPES: Record<string, string> = { "\u0007": "\\a", "\b": "\\b", "\t": "\\t", "\n": "\\n", "\v": "\\v", "\f": "\\f", "\r": "\\r", '"': '\\"', "\\": "\\\\" };
/** A path as git prints it in a diff with core.quotePath off: in quotes, escaped C-style, when it holds `"`, `\` or a control character. */
const gitName = (p: string) =>
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f"\\\u007f]/.test(p) ? `"${p.replace(/[\u0000-\u001f"\\\u007f]/g, (c) => C_ESCAPES[c] ?? `\\${c.charCodeAt(0).toString(8).padStart(3, "0")}`)}"` : p;

/**
 * Whether `patch` is a `git diff --binary --full-index` of changes to each of `files` and nothing else, read line by
 * line: per file its header, its index line, then its hunks with exactly the lines they count, or a binary patch.
 */
function wellFormed(patch: string, files: readonly string[]): boolean {
  if (!patch.endsWith("\n") || patch.includes("\0")) return false;
  const lines = patch.slice(0, -1).split("\n");
  const headers = new Map(files.map((f) => [`diff --git ${gitName(`a/${f}`)} ${gitName(`b/${f}`)}`, f]));
  const seen = new Set<string>();
  let i = 0;
  while (i < lines.length) {
    const f = headers.get(lines[i++]!);
    if (f === undefined || seen.has(f) || !INDEX.test(lines[i++] ?? "")) return false;
    seen.add(f);
    if (lines[i] === "GIT binary patch") {
      i++;
      // The new contents, then the old: each a size line, base85 lines and a blank line.
      for (let half = 0; half < 2; half++) {
        if (!BINARY.test(lines[i++] ?? "")) return false;
        while (BASE85.test(lines[i] ?? "")) i++;
        if (lines[i++] !== "") return false;
      }
      continue;
    }
    // git ends these two lines with a tab when the name holds a space.
    const tab = f.includes(" ") ? "\t" : "";
    if (lines[i++] !== `--- ${gitName(`a/${f}`)}${tab}` || lines[i++] !== `+++ ${gitName(`b/${f}`)}${tab}`) return false;
    let hunks = 0;
    for (let m = HUNK.exec(lines[i] ?? ""); m; m = HUNK.exec(lines[i] ?? ""), hunks++) {
      i++;
      let [before, after] = [Number(m[1] ?? 1), Number(m[2] ?? 1)];
      while (before > 0 || after > 0 || lines[i]?.startsWith("\\ ")) {
        const line = lines[i++] ?? "";
        if (line.startsWith(" ") && before > 0 && after > 0) [before, after] = [before - 1, after - 1];
        else if (line.startsWith("-") && before > 0) before--;
        else if (line.startsWith("+") && after > 0) after--;
        else if (!line.startsWith("\\ ")) return false;
      }
    }
    if (hunks === 0) return false;
  }
  return seen.size === files.length;
}

const GroupSchema = z
  .strictObject({
    id: z.string().max(200),
    files: z.array(RelativePath).min(1).max(CAPS.files),
    patch: capped(CAPS.patch),
    build: OutcomeSchema.nullable(),
    tests: OutcomeSchema.nullable(),
  })
  .refine((g) => wellFormed(g.patch, g.files), { message: "patch is not a git diff of exactly these files", path: ["patch"] });

const PlanSchema = z.strictObject({
  version: z.literal(PLAN_VERSION),
  darnit: capped(CAPS.darnit),
  base: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, "not a commit id"),
  groups: z.array(GroupSchema).max(CAPS.groups),
});

export type PlanOutcome = z.infer<typeof OutcomeSchema>;
export type PlanGroup = z.infer<typeof GroupSchema>;
export type Plan = z.infer<typeof PlanSchema>;

// Every key in the order it is written, so the same plan is always the same bytes.
const KEYS = ["version", "darnit", "base", "groups", "id", "files", "patch", "build", "tests", "command", "passed", "attributed", "notChecked", "timedOut", "output"];

/** Checks a plan against the format, its caps and darnit's own records. Throws on the first problem. */
export function parsePlan(text: string, recordIds: ReadonlySet<string>): Plan {
  if (Buffer.byteLength(text) > CAPS.plan) throw new Error(`plan is over the cap of ${CAPS.plan} bytes`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("plan is not JSON");
  }
  const result = PlanSchema.safeParse(json);
  if (!result.success) throw new Error(`invalid plan:\n${z.prettifyError(result.error)}`);
  const ids = result.data.groups.map((g) => g.id);
  const unknown = ids.find((id) => !recordIds.has(id));
  if (unknown !== undefined) throw new Error(`plan names a change record this darnit does not have: ${JSON.stringify(unknown)}`);
  if (new Set(ids).size < ids.length) throw new Error("plan names a change record twice");
  return result.data;
}

/**
 * The plan as written: stable key order, and every control, line separator or C1 character in a string escaped,
 * so the file shows as plain text. Checked with parsePlan first, so no plan darnit writes is one it would refuse.
 */
export function serializePlan(plan: Plan, recordIds: ReadonlySet<string>): string {
  const text = `${JSON.stringify(plan, KEYS, 2)}\n`.replace(/[\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  parsePlan(text, recordIds);
  return text;
}
