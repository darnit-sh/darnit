import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { z } from "zod";
import { LANGS, type ChangeRecord, type Lang } from "../records/schema.js";
import { findMatches, grammarFor } from "../scan/astgrep.js";
import { applyRules, ruleFiles } from "./apply.js";

// The fixture contract for a pack, per fixtures/<case>/:
//   before/         files as a user would write them
//   after/          byte-exact result of applying rules/ to before/
//   expected.json   detection match counts per before/ file
// Two checks per case: detection counts must match exactly, and applying the
// rules must reproduce after/. Silence is failure: zero expected matches, or
// rules that change nothing, both fail; ast-grep does not complain about a
// malformed rule, so the fixture has to.

const ExpectedSchema = z
  .object({
    matches: z.record(z.string(), z.number().int().nonnegative()),
    note: z.string().optional(),
  })
  .strict();

export type CaseResult = {
  pack: string;
  case: string;
  problems: string[];
};

async function subdirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** All files under `dir`, as sorted paths relative to it. */
async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

function firstDifference(expected: string, actual: string): string {
  const e = expected.split("\n");
  const a = actual.split("\n");
  for (let i = 0; i < Math.max(e.length, a.length); i++) {
    if (e[i] !== a[i]) {
      return `line ${i + 1}: expected ${JSON.stringify(e[i] ?? "<EOF>")}, got ${JSON.stringify(a[i] ?? "<EOF>")}`;
    }
  }
  return "(identical text, differing bytes; line endings or trailing newline?)";
}

async function checkDetection(record: ChangeRecord, caseDir: string, problems: string[]): Promise<void> {
  const raw = await readFile(join(caseDir, "expected.json"), "utf8").catch(() => undefined);
  if (raw === undefined) {
    problems.push("missing expected.json");
    return;
  }
  const parsed = ExpectedSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    problems.push(`invalid expected.json:\n${z.prettifyError(parsed.error)}`);
    return;
  }
  const expected = parsed.data.matches;
  const beforeDir = join(caseDir, "before");
  const seen = new Set<string>();
  for (const file of await listFiles(beforeDir)) {
    const grammar = grammarFor(file);
    if (!grammar) continue;
    const key = `before/${file}`;
    seen.add(key);
    const patterns = record.detection.astGrepPatterns[grammar.lang] ?? [];
    const source = await readFile(join(beforeDir, file), "utf8");
    const count = findMatches(source, grammar.grammar, patterns).length;
    const want = expected[key];
    if (want === undefined) problems.push(`${key}: not listed in expected.json (detection found ${count})`);
    else if (want !== count) problems.push(`${key}: expected ${want} detection matches, found ${count}`);
  }
  for (const key of Object.keys(expected)) {
    if (!seen.has(key)) problems.push(`${key}: listed in expected.json but not present in before/`);
  }
  const total = Object.values(expected).reduce((a, b) => a + b, 0);
  if (total === 0) problems.push("expected.json expects zero matches everywhere; a fixture must exercise detection");
}

async function checkRewrite(packDir: string, caseDir: string, problems: string[]): Promise<void> {
  const beforeDir = join(caseDir, "before");
  const afterDir = join(caseDir, "after");
  const langsWithRules = new Set<Lang>();
  for (const lang of LANGS) if ((await ruleFiles(packDir, lang)).length > 0) langsWithRules.add(lang);

  const work = await mkdtemp(join(tmpdir(), "darnit-fixture-"));
  try {
    await cp(beforeDir, work, { recursive: true });
    try {
      await applyRules(packDir, [work]);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
      return;
    }

    const afterFiles = await listFiles(afterDir);
    const gotFiles = await listFiles(work);
    if (afterFiles.length === 0) {
      problems.push("missing after/; every case needs the expected result, even when no rules apply");
      return;
    }
    if (afterFiles.join("\n") !== gotFiles.join("\n")) {
      problems.push(`after/ lists [${afterFiles.join(", ")}] but rules produced [${gotFiles.join(", ")}]`);
      return;
    }

    const present = new Set<Lang>();
    const changed = new Set<Lang>();
    for (const file of afterFiles) {
      const [want, got, before] = await Promise.all([
        readFile(join(afterDir, file), "utf8"),
        readFile(join(work, file), "utf8"),
        readFile(join(beforeDir, file), "utf8"),
      ]);
      if (want !== got) problems.push(`after/${file} does not match rules applied to before/${file}: ${firstDifference(want, got)}`);
      const lang = grammarFor(file)?.lang;
      if (!lang) continue;
      present.add(lang);
      if (got !== before) changed.add(lang);
    }
    for (const lang of langsWithRules) {
      if (present.has(lang) && !changed.has(lang)) {
        problems.push(`rules/${lang}/ applied 0 changes to before/; a silent no-match is a broken rule, not a pass`);
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Runs every fixture case of one pack. A pack with no fixtures fails: it does not ship. */
export async function runPackFixtures(packDir: string, record: ChangeRecord): Promise<CaseResult[]> {
  const pack = basename(packDir);
  const cases = await subdirs(join(packDir, "fixtures"));
  if (cases.length === 0) {
    return [{ pack, case: "-", problems: ["no fixtures/ cases; a pack without passing fixtures does not ship"] }];
  }
  const results: CaseResult[] = [];
  for (const name of cases) {
    const caseDir = join(packDir, "fixtures", name);
    const problems: string[] = [];
    try {
      await checkDetection(record, caseDir, problems);
      await checkRewrite(packDir, caseDir, problems);
    } catch (err) {
      problems.push(`fixture case is unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
    results.push({ pack, case: name, problems });
  }
  return results;
}
