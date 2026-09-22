import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, title } from "./check.js";
import { diff, diffDirs, isRepo } from "./git.js";
import { applyRules, hasRules } from "./packs/apply.js";
import { loadRecords } from "./records/load.js";
import type { ChangeRecord } from "./records/schema.js";
import { detectTestCommand, runTests, type TestRun } from "./tests.js";

export type FixOptions = {
  dryRun?: boolean;
  only?: string[];
  test?: string;
  noTest?: boolean;
  color?: boolean;
};

export type RecordResult = {
  record: ChangeRecord;
  title: string;
  files: string[];
  applied: boolean;
  /** why not applied, when applied is false */
  reason?: string;
};

export type TestOutcome = TestRun & {
  /** "change": tests passed before and failed after; "baseline": they already failed before */
  attributed?: "change" | "baseline";
};

export type FixResult = {
  records: RecordResult[];
  dryRun: boolean;
  /** undefined when no test command was found or tests were skipped */
  tests?: TestOutcome | undefined;
  testsSkipped: boolean;
  diff: string;
  /** true when tests failed and the files were put back */
  reverted: boolean;
};

/** darnit declined to act; the message says what to change */
export class Refusal extends Error {}

type Group = { record: ChangeRecord; packDir: string; files: string[] };

async function groupHits(root: string, only: string[] | undefined): Promise<Group[]> {
  const packs = new Map((await loadRecords()).map((l) => [l.record.id, l.packDir]));
  for (const id of only ?? []) if (!packs.has(id)) throw new Refusal(`unknown change record: ${id}`);
  const byId = new Map<string, Group>();
  for (const hit of await check(root)) {
    if (only && !only.includes(hit.record.id)) continue;
    const group = byId.get(hit.record.id) ?? { record: hit.record, packDir: packs.get(hit.record.id)!, files: [] };
    if (!group.files.includes(hit.file)) group.files.push(hit.file);
    byId.set(hit.record.id, group);
  }
  return [...byId.values()];
}

export async function fix(root: string, opts: FixOptions = {}): Promise<FixResult> {
  const color = opts.color ?? false;
  if (!opts.dryRun && !(await isRepo(root))) {
    throw new Refusal("not a git repository; darnit only edits files it can undo. Use --dry-run to preview.");
  }

  const groups = await groupHits(root, opts.only);
  const records: RecordResult[] = [];
  const touched: string[] = [];
  const applicable: Group[] = [];
  for (const g of groups) {
    const applied = await hasRules(g.packDir);
    records.push({ record: g.record, title: title(g.record), files: g.files, applied, ...(applied ? {} : { reason: "no rewrite rules yet" }) });
    if (applied) {
      applicable.push(g);
      for (const f of g.files) if (!touched.includes(f)) touched.push(f);
    }
  }
  const dryRun = opts.dryRun ?? false;
  if (applicable.length === 0) return { records, dryRun, testsSkipped: true, diff: "", reverted: false };

  if (opts.dryRun) {
    const tmp = await mkdtemp(join(tmpdir(), "darnit-dry-"));
    try {
      const before = join(tmp, "before");
      const after = join(tmp, "after");
      for (const f of touched) {
        await cp(join(root, f), join(before, f));
        await cp(join(root, f), join(after, f));
      }
      for (const g of applicable) await applyRules(g.packDir, g.files.map((f) => join(after, f)));
      const out = (await diffDirs(tmp, "before", "after", color)).replaceAll("a/before/", "a/").replaceAll("b/after/", "b/");
      return { records, dryRun, testsSkipped: true, diff: out, reverted: false };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  const snapshot = new Map<string, string>();
  for (const f of touched) snapshot.set(f, await readFile(join(root, f), "utf8"));
  for (const g of applicable) await applyRules(g.packDir, g.files.map((f) => join(root, f)));

  let tests: TestOutcome | undefined;
  let reverted = false;
  const command = opts.noTest ? undefined : (opts.test ?? (await detectTestCommand(root)));
  if (command) {
    tests = await runTests(root, command);
    if (!tests.passed) {
      for (const [f, text] of snapshot) await writeFile(join(root, f), text);
      reverted = true;
      const baseline = await runTests(root, command);
      tests.attributed = baseline.passed ? "change" : "baseline";
    }
  }

  const out = reverted ? "" : await diff(root, touched, color);
  return { records, dryRun, tests, testsSkipped: opts.noTest ?? false, diff: out, reverted };
}

export function exitCodeFor(result: FixResult): 0 | 1 {
  return result.tests && !result.tests.passed ? 1 : 0;
}

export function renderSummary(result: FixResult): string {
  const lines: string[] = [];
  for (const r of result.records) {
    const where = `${r.files.length} file${r.files.length === 1 ? "" : "s"}`;
    lines.push(r.applied ? `✓ ${r.title}: ${where}` : `- ${r.title}: ${where} reported, ${r.reason}`);
  }
  if (lines.length === 0) lines.push("Nothing to fix.");
  if (result.dryRun) {
    if (result.records.some((r) => r.applied)) lines.push("dry run: nothing written");
  } else if (result.tests) {
    const t = result.tests;
    if (t.passed) lines.push(`tests: ${t.command} passed`);
    else if (t.attributed === "change") lines.push(`tests: ${t.command} failed after the change; files put back. The change broke your tests.`);
    else lines.push(`tests: ${t.command} failed; files put back. They already fail without the change.`);
    if (!t.passed && t.output) lines.push(t.output);
  } else if (result.testsSkipped) {
    if (result.records.some((r) => r.applied)) lines.push("tests: skipped");
  } else if (result.records.some((r) => r.applied)) {
    lines.push("tests: none found (no test script or pytest setup)");
  }
  return lines.join("\n");
}

export function toJson(result: FixResult): object {
  return {
    records: result.records.map((r) => ({ id: r.record.id, title: r.title, files: r.files, applied: r.applied, reason: r.reason })),
    tests: result.tests
      ? { command: result.tests.command, passed: result.tests.passed, attributed: result.tests.attributed, output: result.tests.output }
      : null,
    testsSkipped: result.testsSkipped,
    dryRun: result.dryRun,
    reverted: result.reverted,
    diff: result.diff,
  };
}
