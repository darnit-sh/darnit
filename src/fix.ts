import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, scan, title } from "./check.js";
import * as g from "./git.js";
import { createPr, defaultBranch, findOpenPr, githubToken, parseRemote, parseSlug } from "./github.js";
import { applyRules, hasRules } from "./packs/apply.js";
import { loadRecords } from "./records/load.js";
import type { ChangeRecord } from "./records/schema.js";
import { detectTestCommand, runTests, type TestRun } from "./tests.js";

export type FixOptions = {
  dryRun?: boolean;
  pr?: boolean;
  allowDirty?: boolean;
  /** Owner/name when origin is not a GitHub URL. */
  repo?: string;
  only?: string[];
  test?: string;
  noTest?: boolean;
  color?: boolean;
  version?: string;
};

export type TestOutcome = TestRun & {
  /** "change": passed before, failed after. "baseline": already failing before. */
  attributed?: "change" | "baseline";
};

export type PrResult =
  | { state: "opened"; url: string; tests?: TestOutcome | undefined }
  | { state: "exists"; url: string }
  | { state: "skipped"; reason: string }
  | { state: "tests-failed"; tests: TestOutcome };

export type Site = { file: string; line: number };

export type RecordResult = {
  record: ChangeRecord;
  title: string;
  files: string[];
  /** Call sites check reported before the rewrite. */
  sites: number;
  applied: boolean;
  reason?: string;
  /** Call sites still detected after the rewrite: they need a human. */
  remaining?: Site[];
  pr?: PrResult;
};

export type FixResult = {
  records: RecordResult[];
  dryRun: boolean;
  pr: boolean;
  tests?: TestOutcome | undefined;
  testsSkipped: boolean;
  diff: string;
  reverted: boolean;
};

/** Thrown when darnit declines to act; the message says what to change. */
export class Refusal extends Error {}

type Group = { record: ChangeRecord; packDir: string; files: string[]; sites: number };

const NOT_COVERED = "found, but the rewrite rules don't cover this call shape yet";

async function groupHits(root: string, only: string[] | undefined): Promise<Group[]> {
  const packs = new Map((await loadRecords()).map((l) => [l.record.id, l.packDir]));
  for (const id of only ?? []) if (!packs.has(id)) throw new Refusal(`unknown change record: ${id}`);
  const byId = new Map<string, Group>();
  for (const hit of await check(root)) {
    if (only && !only.includes(hit.record.id)) continue;
    const group = byId.get(hit.record.id) ?? { record: hit.record, packDir: packs.get(hit.record.id)!, files: [], sites: 0 };
    if (!group.files.includes(hit.file)) group.files.push(hit.file);
    group.sites++;
    byId.set(hit.record.id, group);
  }
  return [...byId.values()];
}

async function snapshotOf(root: string, files: readonly string[]): Promise<Map<string, string>> {
  const snap = new Map<string, string>();
  for (const f of files) snap.set(f, await readFile(join(root, f), "utf8"));
  return snap;
}

async function restore(root: string, snap: Map<string, string>): Promise<void> {
  for (const [f, text] of snap) await writeFile(join(root, f), text);
}

/**
 * Applies a group's rules under `dir`, then checks the result instead of trusting it:
 * whether any file changed, and which of the record's call sites are still detected.
 */
type Outcome = { changed: string[]; remaining: Site[] };

async function applyAndVerify(dir: string, grp: Group): Promise<Outcome> {
  const before = await snapshotOf(dir, grp.files);
  await applyRules(grp.packDir, grp.files.map((f) => join(dir, f)));
  const changed: string[] = [];
  for (const [f, text] of before) if ((await readFile(join(dir, f), "utf8")) !== text) changed.push(f);
  const { hits } = await scan(dir, grp.files, [grp.record]);
  return { changed, remaining: hits.map((h) => ({ file: h.file, line: h.line })) };
}

/** Records the verified outcome on the record's result. Returns the files actually rewritten. */
function settle(result: RecordResult, outcome: Outcome): string[] {
  if (outcome.changed.length === 0) {
    result.applied = false;
    result.reason = NOT_COVERED;
  } else if (outcome.remaining.length > 0) {
    result.remaining = outcome.remaining;
  }
  return outcome.changed;
}

/** Runs tests; on failure puts the files back and runs again to say whether the change was the cause. */
async function testAndAttribute(root: string, command: string, snap: Map<string, string>): Promise<TestOutcome> {
  const tests: TestOutcome = await runTests(root, command);
  if (!tests.passed) {
    await restore(root, snap);
    tests.attributed = (await runTests(root, command)).passed ? "change" : "baseline";
  }
  return tests;
}

export async function fix(root: string, opts: FixOptions = {}): Promise<FixResult> {
  const color = opts.color ?? false;
  const dryRun = opts.dryRun ?? false;
  if (!dryRun && !(await g.isRepo(root))) {
    throw new Refusal("not a git repository; darnit only edits files it can undo. Use --dry-run to preview.");
  }

  const groups = await groupHits(root, opts.only);
  const records: RecordResult[] = [];
  const applicable: Group[] = [];
  for (const grp of groups) {
    const reviewed = grp.record.status === "reviewed";
    const mechanical = grp.record.classification === "mechanical";
    const applied = reviewed && mechanical && (await hasRules(grp.packDir));
    const reason = !reviewed
      ? "unreviewed change record"
      : !mechanical
        ? "migration not yet automated; see the record notes"
        : "no rewrite rules yet";
    records.push({ record: grp.record, title: title(grp.record), files: grp.files, sites: grp.sites, applied, ...(applied ? {} : { reason }) });
    if (applied) applicable.push(grp);
  }
  const resultOf = (grp: Group) => records.find((r) => r.record.id === grp.record.id)!;
  const base = { records, dryRun, pr: opts.pr ?? false, testsSkipped: opts.noTest ?? false, diff: "", reverted: false };
  if (applicable.length === 0) return base;

  if (dryRun) {
    const tmp = await mkdtemp(join(tmpdir(), "darnit-dry-"));
    try {
      for (const f of new Set(applicable.flatMap((grp) => grp.files))) {
        await cp(join(root, f), join(tmp, "before", f));
        await cp(join(root, f), join(tmp, "after", f));
      }
      for (const grp of applicable) settle(resultOf(grp), await applyAndVerify(join(tmp, "after"), grp));
      const out = (await g.diffDirs(tmp, "before", "after", color)).replaceAll("a/before/", "a/").replaceAll("b/after/", "b/");
      return { ...base, diff: out };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  const command = opts.noTest ? undefined : (opts.test ?? (await detectTestCommand(root)));
  if (opts.pr) return pullRequests(root, applicable, base, command, opts);

  const snap = await snapshotOf(root, [...new Set(applicable.flatMap((grp) => grp.files))]);
  const touched: string[] = [];
  try {
    for (const grp of applicable) {
      for (const f of settle(resultOf(grp), await applyAndVerify(root, grp))) if (!touched.includes(f)) touched.push(f);
    }
  } catch (err) {
    await restore(root, snap);
    throw err;
  }
  if (touched.length === 0) return base;
  const tests = command ? await testAndAttribute(root, command, snap) : undefined;
  const reverted = tests !== undefined && !tests.passed;
  return { ...base, tests, diff: reverted ? "" : await g.diff(root, touched, color), reverted };
}

// One branch, one test run and one pull request per change. The working tree is
// left exactly as it was found, on the branch it was found on.
async function pullRequests(root: string, groups: Group[], base: FixResult, command: string | undefined, opts: FixOptions): Promise<FixResult> {
  if (!opts.allowDirty && !(await g.isClean(root))) {
    throw new Refusal("uncommitted changes in the working tree; commit or stash them, or pass --allow-dirty");
  }
  // --allow-dirty tolerates edits elsewhere, never in the files darnit is about to commit.
  const wanted = [...new Set(groups.flatMap((grp) => grp.files))];
  if (await g.dirtyAmong(root, wanted)) {
    throw new Refusal("uncommitted changes in files darnit needs to edit; commit or stash them first");
  }
  const repo = opts.repo ? parseSlug(opts.repo) : parseRemote(await g.remoteUrl(root).catch(() => ""));
  if (!repo) throw new Refusal("could not tell which GitHub repository this is; pass --repo owner/name");
  const token = await githubToken();
  if (!token) throw new Refusal("no GitHub token; set GITHUB_TOKEN or GH_TOKEN, or run: gh auth login");
  const target = await defaultBranch(token, repo);
  const home = await g.position(root);
  let anyFailed = false;

  for (const grp of groups) {
    const result = base.records.find((r) => r.record.id === grp.record.id)!;
    const branch = `darnit/${grp.record.vendor}-${grp.record.id.split(":")[2]}`;
    const existing = await findOpenPr(token, repo, branch);
    if (existing) {
      result.pr = { state: "exists", url: existing };
      continue;
    }
    if ((await g.localBranchExists(root, branch)) || (await g.remoteBranchExists(root, branch))) {
      result.pr = { state: "skipped", reason: `branch ${branch} already exists; delete it or open the pull request from it yourself` };
      continue;
    }

    const snap = await snapshotOf(root, grp.files);
    await g.switchTo(root, branch, "create");
    let committed = false;
    let opened = false;
    try {
      const changed = settle(result, await applyAndVerify(root, grp));
      if (changed.length === 0) continue;
      const tests = command ? await testAndAttribute(root, command, snap) : undefined;
      if (tests && !tests.passed) {
        result.pr = { state: "tests-failed", tests };
        anyFailed = true;
        continue;
      }
      await g.add(root, changed);
      await g.commit(root, result.title, `Source: ${grp.record.sources[0]!.url}`);
      committed = true;
      await g.push(root, branch);
      const url = await createPr(token, repo, { title: result.title, head: branch, base: target, body: prBody(grp.record, changed, tests, opts.version ?? "dev", result.remaining) });
      result.pr = { state: "opened", url, tests };
      opened = true;
    } catch (err) {
      // Once committed, the tree already matches the branch; restoring would only block the switch back.
      if (!committed) await restore(root, snap);
      throw err;
    } finally {
      await g.switchTo(root, home.ref, home.detached ? "detach" : "existing");
      if (!opened) await g.deleteBranch(root, branch).catch(() => undefined);
    }
  }
  return { ...base, reverted: anyFailed };
}

/** Record text can come from vendor specs: GitHub renders a code span as literal text, so no links, HTML or mentions. */
const plain = (text: string) => {
  const t = text.replaceAll("`", "'").replace(/\s+/g, " ").trim();
  return t ? `\`${t}\`` : "";
};

export function prBody(record: ChangeRecord, files: readonly string[], tests: TestOutcome | undefined, version: string, remaining: readonly Site[] = []): string {
  const source = record.sources[0]!;
  return [
    plain(record.notes?.migration ?? title(record)),
    "",
    "## Why",
    `${record.vendor} announced this change on ${record.announcedAt}: ${source.url}`,
    ...(source.quoteId ? [`> ${plain(source.quoteId)}`] : []),
    "",
    "## What changed",
    ...files.map((f) => `- \`${f}\``),
    "",
    "## Verified",
    tests ? `- [${tests.passed ? "x" : " "}] \`${tests.command}\` ${tests.passed ? "passed" : "failed"}` : "- [ ] no test command found in this repository",
    ...(tests?.output ? ["", "<details><summary>test output</summary>", "", "```", tests.output, "```", "", "</details>"] : []),
    "",
    ...(remaining.length > 0
      ? ["## Needs a human", "These call sites were found but not rewritten:", ...remaining.map((r) => `- \`${r.file}:${r.line}\``), ""]
      : []),
    "## Not verified",
    "- No generated regression tests yet; the checks above are the repository's own.",
    "- Options objects built in one place and passed by name are not covered.",
    ...(record.notes?.edgeCases ?? []).map((e) => `- ${plain(e)}`),
    "",
    "---",
    `darnit ${version}, change record \`${record.id}\``,
    "",
  ].join("\n");
}

export function exitCodeFor(result: FixResult): 0 | 1 {
  if (result.tests && !result.tests.passed) return 1;
  return result.records.some((r) => r.pr?.state === "tests-failed") ? 1 : 0;
}

function testLine(t: TestOutcome): string {
  if (t.passed) return `tests: ${t.command} passed`;
  const why = t.attributed === "change" ? "The change broke your tests." : "They already fail without the change.";
  return `tests: ${t.command} failed; files put back. ${why}${t.output ? `\n${t.output}` : ""}`;
}

export function renderSummary(result: FixResult): string {
  const lines: string[] = [];
  for (const r of result.records) {
    const where = `${r.files.length} file${r.files.length === 1 ? "" : "s"}`;
    if (!r.applied) lines.push(`- ${r.title}: ${where} reported, ${r.reason}`);
    else if (!r.pr) lines.push(`✓ ${r.title}: ${r.remaining ? `${r.sites - r.remaining.length} of ${r.sites} call sites rewritten` : where}`);
    else if (r.pr.state === "opened") lines.push(`✓ ${r.title}: pull request opened ${r.pr.url}${r.pr.tests ? `\n  ${testLine(r.pr.tests)}` : ""}`);
    else if (r.pr.state === "exists") lines.push(`= ${r.title}: pull request already open ${r.pr.url}`);
    else if (r.pr.state === "skipped") lines.push(`- ${r.title}: skipped, ${r.pr.reason}`);
    else lines.push(`✗ ${r.title}: nothing pushed\n  ${testLine(r.pr.tests)}`);
    if (r.applied) for (const s of r.remaining ?? []) lines.push(`  needs a human: ${s.file}:${s.line}`);
  }
  if (lines.length === 0) lines.push("Nothing to fix.");
  const applied = result.records.some((r) => r.applied);
  if (result.dryRun) {
    if (applied) lines.push("dry run: nothing written");
  } else if (result.pr) {
    // Per-record lines already carry the test result.
  } else if (result.tests) {
    lines.push(testLine(result.tests));
  } else if (applied) {
    lines.push(result.testsSkipped ? "tests: skipped" : "tests: none found (no test script or pytest setup)");
  }
  return lines.join("\n");
}

export function toJson(result: FixResult): object {
  const tests = (t: TestOutcome | undefined) => (t ? { command: t.command, passed: t.passed, attributed: t.attributed, output: t.output } : null);
  return {
    records: result.records.map((r) => ({
      id: r.record.id,
      title: r.title,
      files: r.files,
      applied: r.applied,
      reason: r.reason,
      sites: r.sites,
      remaining: r.remaining ?? [],
      pr: r.pr ? { ...r.pr, ...("tests" in r.pr ? { tests: tests(r.pr.tests) } : {}) } : null,
    })),
    tests: tests(result.tests),
    testsSkipped: result.testsSkipped,
    dryRun: result.dryRun,
    reverted: result.reverted,
    diff: result.diff,
  };
}
