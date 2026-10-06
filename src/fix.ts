import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReport, scan, title } from "./check.js";
import * as g from "./git.js";
import { vendorName } from "./detect.js";
import { createPr, defaultBranch, findOpenPr, githubToken, parseRemote, parseSlug } from "./github.js";
import { applyRules, hasRules } from "./packs/apply.js";
import { loadRecords } from "./records/load.js";
import type { ChangeRecord } from "./records/schema.js";
import { detectBuildCommand, detectTestCommand, hasPytestSetup, runTests, type TestRun } from "./tests.js";
import { atLeast, npmVersionFor, pypiVersions, type Found } from "./versions.js";

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
  /** What was run: the repo's build or typecheck, or its tests. */
  kind: "build" | "tests";
  /** "change": passed before, failed after. "baseline": already failing before. */
  attributed?: "change" | "baseline";
  /** A build that already failed before the change says nothing about it: the change is kept and this is reported instead. */
  notChecked?: boolean;
};

/** A check that failed because of the change, or (for tests) failed at all. A build that was already broken is not one. */
const failed = (c: TestOutcome | undefined): boolean => c !== undefined && !c.passed && !c.notChecked;

export type PrResult =
  | { state: "opened"; url: string; build?: TestOutcome | undefined; tests?: TestOutcome | undefined }
  | { state: "exists"; url: string }
  | { state: "skipped"; reason: string }
  | { state: "tests-failed"; tests: TestOutcome }
  | { state: "build-failed"; build: TestOutcome };

export type Site = { file: string; line: number; note?: string };

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
  /** Package versions the rewrite needs that darnit could not find in the repo, e.g. "openai >= 1.45.0". */
  unconfirmed?: string[];
  pr?: PrResult;
};

export type FixResult = {
  records: RecordResult[];
  dryRun: boolean;
  pr: boolean;
  build?: TestOutcome | undefined;
  tests?: TestOutcome | undefined;
  testsSkipped: boolean;
  /** Why no tests ran, when darnit found a test setup it could not run. */
  testsNote?: string | undefined;
  diff: string;
  reverted: boolean;
};

/** Thrown when darnit declines to act; the message says what to change. */
export class Refusal extends Error {}

/**
 * One record's call sites. `files` and `sites` are what the rules may rewrite; `held` are the
 * record's sites in files that also call another provider through the same methods. The rules
 * would rewrite those foreign calls too, so such files are left alone and their sites go to a human.
 */
export type Group = { record: ChangeRecord; packDir: string; files: string[]; sites: number; held?: Site[] };

const MIXED = "this file also calls another provider through the same methods";

const NOT_COVERED = "the rewrite rules don't cover this call shape yet";

async function groupHits(root: string, only: string[] | undefined): Promise<Group[]> {
  const packs = new Map((await loadRecords()).map((l) => [l.record.id, l.packDir]));
  for (const id of only ?? []) if (!packs.has(id)) throw new Refusal(`unknown change record: ${id}`);
  const { hits, foreign } = await checkReport(root);
  const mixed = new Set(foreign.map((h) => `${h.record.id}\0${h.file}`));
  const byId = new Map<string, Group>();
  for (const hit of hits) {
    if (only && !only.includes(hit.record.id)) continue;
    const group = byId.get(hit.record.id) ?? { record: hit.record, packDir: packs.get(hit.record.id)!, files: [], sites: 0 };
    if (mixed.has(`${hit.record.id}\0${hit.file}`)) {
      (group.held ??= []).push({ file: hit.file, line: hit.line, note: MIXED });
    } else {
      if (!group.files.includes(hit.file)) group.files.push(hit.file);
      group.sites++;
    }
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
 * A rewrite that changed bytes but removed no call site is no rewrite: the files are put back.
 */
type Outcome = { changed: string[]; remaining: Site[] };

export async function applyAndVerify(dir: string, grp: Group): Promise<Outcome> {
  const before = await snapshotOf(dir, grp.files);
  await applyRules(grp.packDir, grp.files.map((f) => join(dir, f)));
  const changed: string[] = [];
  for (const [f, text] of before) if ((await readFile(join(dir, f), "utf8")) !== text) changed.push(f);
  const remaining = (await scan(dir, grp.files, [grp.record])).hits.map((h) => ({ file: h.file, line: h.line }));
  if (changed.length > 0 && remaining.length >= grp.sites) {
    await restore(dir, before);
    return { changed: [], remaining };
  }
  return { changed, remaining };
}

/**
 * Checks the repo uses package versions new enough for the rewritten code.
 * Returns why the rewrite must not run, or the requirements nobody could confirm.
 * Node: the install nearest each JavaScript or TypeScript file, as Node resolves it.
 * Python: the most authoritative pin or lock; blocks when all its entries are too old, and
 * cannot confirm when they disagree.
 */
async function versionGate(root: string, grp: Group): Promise<{ blocked?: string; unconfirmed: string[] }> {
  const requires = grp.record.fix?.requires ?? {};
  const js = grp.files.filter((f) => !f.endsWith(".py"));
  const py = grp.files.length > js.length;
  const unconfirmed: string[] = [];
  const tooOld = (pkg: string, min: string, found: Found) =>
    `needs ${pkg} >= ${min}, this repo has ${found.version} (${found.from}); upgrade it first`;

  for (const [pkg, min] of js.length > 0 ? Object.entries(requires.npm ?? {}) : []) {
    let unknown = false;
    for (const file of js) {
      const found = await npmVersionFor(root, pkg, file).catch(() => undefined);
      if (!found) unknown = true;
      else if (!atLeast(found.version, min)) return { blocked: tooOld(pkg, min, found), unconfirmed };
    }
    if (unknown) unconfirmed.push(`${pkg} >= ${min} (npm)`);
  }
  for (const [pkg, min] of py ? Object.entries(requires.pypi ?? {}) : []) {
    const found = await pypiVersions(root, pkg);
    const ok = found.filter((f) => atLeast(f.version, min));
    if (found.length > 0 && ok.length === 0) return { blocked: tooOld(pkg, min, found[0]!), unconfirmed };
    if (ok.length < found.length || found.length === 0) unconfirmed.push(`${pkg} >= ${min} (PyPI)`);
  }
  return { unconfirmed };
}

/** Records the verified outcome on the record's result. Returns the files actually rewritten. */
function settle(result: RecordResult, outcome: Outcome, held: readonly Site[] = []): string[] {
  if (outcome.changed.length === 0) {
    result.applied = false;
    result.reason = NOT_COVERED;
    if (held.length > 0) result.remaining = [...held];
  } else if (outcome.remaining.length + held.length > 0) {
    result.remaining = [...outcome.remaining, ...held];
  }
  return outcome.changed;
}

/** Runs a check; on failure puts the files back and runs it again to say whether the change was the cause. */
async function testAndAttribute(root: string, command: string, snap: Map<string, string>, kind: TestOutcome["kind"]): Promise<TestOutcome> {
  const outcome: TestOutcome = { ...(await runTests(root, command)), kind };
  if (!outcome.passed) {
    const changed = await snapshotOf(root, [...snap.keys()]);
    await restore(root, snap);
    outcome.attributed = (await runTests(root, command)).passed ? "change" : "baseline";
    // A build that fails without the change too (missing dependencies, secrets, an unrelated error)
    // cannot judge it. Put the change back and say so, rather than blocking a fix the build never saw.
    if (kind === "build" && outcome.attributed === "baseline") {
      await restore(root, changed);
      outcome.notChecked = true;
    }
  }
  return outcome;
}

type Commands = { build?: string | undefined; tests?: string | undefined };

const COMPILED = /\.(m?[jt]sx?|c[jt]s)$/;

/**
 * The build check first, then the tests; stops at the first failure, which has already put the files back.
 * The build only runs when JavaScript or TypeScript changed: it says nothing about a Python fix.
 */
async function runChecks(root: string, commands: Commands, snap: Map<string, string>): Promise<{ build?: TestOutcome; tests?: TestOutcome }> {
  // Builds and tests can write tracked files (a committed dist/, generated types). Put back anything
  // they touched that was clean before, so the tree only differs by the rewrite.
  const dirtyBefore = new Set(await g.modified(root));
  try {
    const compiled = [...snap.keys()].some((f) => COMPILED.test(f));
    const build = commands.build && compiled ? await testAndAttribute(root, commands.build, snap, "build") : undefined;
    if (failed(build)) return { build: build! };
    const tests = commands.tests ? await testAndAttribute(root, commands.tests, snap, "tests") : undefined;
    return { ...(build ? { build } : {}), ...(tests ? { tests } : {}) };
  } finally {
    await g.discard(root, (await g.modified(root)).filter((f) => !dirtyBefore.has(f) && !snap.has(f)));
  }
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
    const clean = grp.files.length > 0;
    const ready = reviewed && mechanical && clean && (await hasRules(grp.packDir));
    const gate = ready ? await versionGate(root, grp) : { unconfirmed: [] };
    const applied = ready && !gate.blocked;
    const reason = !reviewed
      ? "unreviewed change record"
      : !mechanical
        ? "migration not yet automated; see the record notes"
        : !clean
          ? `${new Set(grp.held?.map((h) => h.file)).size === 1 ? "this file" : "each of these files"} also calls another provider through the same methods, so the rewrite would change those calls too`
          : !ready
            ? "no rewrite rules yet"
            : gate.blocked;
    records.push({
      record: grp.record,
      title: title(grp.record),
      files: [...new Set([...grp.files, ...(grp.held ?? []).map((h) => h.file)])],
      sites: grp.sites + (grp.held?.length ?? 0),
      applied,
      ...(applied ? {} : { reason }),
      // Held sites are known before any rewrite; list them even when nothing else is applied.
      ...(!clean && grp.held?.length ? { remaining: grp.held } : {}),
      ...(applied && gate.unconfirmed.length > 0 ? { unconfirmed: gate.unconfirmed } : {}),
    });
    if (applied) applicable.push(grp);
  }
  const resultOf = (grp: Group) => records.find((r) => r.record.id === grp.record.id)!;
  const base: FixResult = { records, dryRun, pr: opts.pr ?? false, testsSkipped: opts.noTest ?? false, diff: "", reverted: false };
  if (applicable.length === 0) return base;

  if (dryRun) {
    const tmp = await mkdtemp(join(tmpdir(), "darnit-dry-"));
    try {
      for (const f of new Set(applicable.flatMap((grp) => grp.files))) {
        await cp(join(root, f), join(tmp, "before", f));
        await cp(join(root, f), join(tmp, "after", f));
      }
      for (const grp of applicable) settle(resultOf(grp), await applyAndVerify(join(tmp, "after"), grp), grp.held);
      const out = (await g.diffDirs(tmp, "before", "after", color)).replaceAll("a/before/", "a/").replaceAll("b/after/", "b/");
      return { ...base, diff: out };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  const commands: Commands = opts.noTest ? {} : { build: await detectBuildCommand(root), tests: opts.test ?? (await detectTestCommand(root)) };
  if (!commands.tests && !opts.noTest && (await hasPytestSetup(root))) base.testsNote = "found a pytest setup but no python3 or python on PATH";
  if (opts.pr) return pullRequests(root, applicable, base, commands, opts);

  const snap = await snapshotOf(root, [...new Set(applicable.flatMap((grp) => grp.files))]);
  const touched: string[] = [];
  try {
    for (const grp of applicable) {
      for (const f of settle(resultOf(grp), await applyAndVerify(root, grp), grp.held)) if (!touched.includes(f)) touched.push(f);
    }
  } catch (err) {
    await restore(root, snap);
    throw err;
  }
  if (touched.length === 0) return base;
  const { build, tests } = await runChecks(root, commands, snap);
  const reverted = failed(build) || failed(tests);
  return { ...base, build, tests, diff: reverted ? "" : await g.diff(root, touched, color), reverted };
}

// One branch, one test run and one pull request per change. The working tree is
// left exactly as it was found, on the branch it was found on.
async function pullRequests(root: string, groups: Group[], base: FixResult, commands: Commands, opts: FixOptions): Promise<FixResult> {
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
      const changed = settle(result, await applyAndVerify(root, grp), grp.held);
      if (changed.length === 0) continue;
      const { build, tests } = await runChecks(root, commands, snap);
      if (build && failed(build)) {
        result.pr = { state: "build-failed", build };
        anyFailed = true;
        continue;
      }
      if (tests && !tests.passed) {
        result.pr = { state: "tests-failed", tests };
        anyFailed = true;
        continue;
      }
      await g.add(root, changed);
      await g.commit(root, result.title, `Source: ${grp.record.sources[0]!.url}`);
      committed = true;
      await g.push(root, branch);
      const body = prBody(grp.record, changed, opts.version ?? "dev", {
        build,
        tests,
        remaining: result.remaining,
        testsNote: base.testsNote,
        unconfirmed: result.unconfirmed,
      });
      const url = await createPr(token, repo, { title: result.title, head: branch, base: target, body });
      result.pr = { state: "opened", url, build, tests };
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

export type PrEvidence = {
  build?: TestOutcome | undefined;
  tests?: TestOutcome | undefined;
  remaining?: readonly Site[] | undefined;
  testsNote?: string | undefined;
  unconfirmed?: readonly string[] | undefined;
};

export function prBody(record: ChangeRecord, files: readonly string[], version: string, evidence: PrEvidence = {}): string {
  const { build, tests, remaining = [], testsNote, unconfirmed = [] } = evidence;
  const source = record.sources[0]!;
  return [
    plain(record.notes?.migration ?? title(record)),
    "",
    "## Why",
    `${vendorName(record.vendor)} announced this change on ${record.announcedAt}: ${source.url}`,
    ...(source.quoteId ? [`> ${plain(source.quoteId)}`] : []),
    "",
    "## What changed",
    ...files.map((f) => `- \`${f}\``),
    "",
    "## Verified",
    ...(build
      ? [
          build.notChecked
            ? `- [ ] \`${build.command}\` already fails without this change, so it could not check it`
            : `- [${build.passed ? "x" : " "}] \`${build.command}\` ${build.passed ? "passed" : "failed"}`,
        ]
      : []),
    tests ? `- [${tests.passed ? "x" : " "}] \`${tests.command}\` ${tests.passed ? "passed" : "failed"}` : `- [ ] ${testsNote ? `tests not run: ${testsNote}` : "no test command found in this repository"}`,
    ...(tests?.output ? ["", "<details><summary>test output</summary>", "", "```", tests.output, "```", "", "</details>"] : []),
    "",
    ...(remaining.length > 0
      ? ["## Needs a human", "These call sites were found but not rewritten:", ...remaining.map((r) => `- \`${r.file}:${r.line}\`${r.note ? `: ${r.note}` : ""}`), ""]
      : []),
    "## Not verified",
    ...unconfirmed.map((u) => `- This change needs ${u}; darnit could not find the version this repository uses.`),
    "- No generated regression tests yet; the checks above are the repository's own.",
    "- Request options built elsewhere and passed in as a variable are not followed.",
    ...(record.notes?.edgeCases ?? []).map((e) => `- ${plain(e)}`),
    "",
    "---",
    `darnit ${version}, change record \`${record.id}\``,
    "",
  ].join("\n");
}

export function exitCodeFor(result: FixResult): 0 | 1 {
  if (failed(result.build) || failed(result.tests)) return 1;
  return result.records.some((r) => r.pr?.state === "tests-failed" || r.pr?.state === "build-failed") ? 1 : 0;
}

function testLine(t: TestOutcome): string {
  if (t.passed) return `${t.kind}: ${t.command} passed`;
  if (t.notChecked) return `${t.kind}: ${t.command} already fails without the change, so it could not check it; change kept`;
  const why =
    t.kind === "build"
      ? t.attributed === "change"
        ? "The change broke your build."
        : "It already fails without the change."
      : t.attributed === "change"
        ? "The change broke your tests."
        : "They already fail without the change. Fix them first, or rerun with --no-test to apply it without the tests or the build check.";
  return `${t.kind}: ${t.command} failed; files put back. ${why}${t.output ? `\n${t.output}` : ""}`;
}

export function renderSummary(result: FixResult): string {
  const lines: string[] = [];
  for (const r of result.records) {
    const where = `${r.files.length} file${r.files.length === 1 ? "" : "s"}`;
    if (!r.applied) lines.push(`- ${r.title}: found in ${where}, not rewritten: ${r.reason}`);
    else if (!r.pr && result.reverted) lines.push(`✗ ${r.title}: rewritten, then put back`);
    else if (!r.pr) lines.push(`✓ ${r.title}: ${r.remaining ? `${r.sites - r.remaining.length} of ${r.sites} call sites rewritten` : where}`);
    else if (r.pr.state === "opened") {
      lines.push(`✓ ${r.title}: pull request opened ${r.pr.url}`);
      for (const c of [r.pr.build, r.pr.tests]) if (c) lines.push(`  ${testLine(c)}`);
    }
    else if (r.pr.state === "exists") lines.push(`= ${r.title}: pull request already open ${r.pr.url}`);
    else if (r.pr.state === "skipped") lines.push(`- ${r.title}: skipped, ${r.pr.reason}`);
    else lines.push(`✗ ${r.title}: nothing pushed\n  ${testLine(r.pr.state === "build-failed" ? r.pr.build : r.pr.tests)}`);
    // Once put back, every call site is unfixed again, not only the ones the rules missed.
    const putBack = !r.pr && result.reverted;
    if (!putBack || !r.applied) for (const s of r.remaining ?? []) lines.push(`  needs a human: ${s.file}:${s.line}${s.note ? ` (${s.note})` : ""}`);
    if (r.applied) for (const u of r.unconfirmed ?? []) lines.push(`  could not confirm ${u}`);
  }
  if (lines.length === 0) lines.push("Nothing to fix.");
  const applied = result.records.some((r) => r.applied);
  if (result.dryRun) {
    if (applied) lines.push("dry run: nothing written");
  } else if (result.pr) {
    // Per-record lines already carry the test result.
  } else if (applied) {
    if (result.build) lines.push(testLine(result.build));
    if (result.tests) lines.push(testLine(result.tests));
    else if (!failed(result.build)) {
      lines.push(
        result.testsSkipped
          ? "tests: skipped"
          : result.testsNote
            ? `tests: none run (${result.testsNote})`
            : "tests: none found (no test script or pytest setup)",
      );
    }
  }
  return lines.join("\n");
}

export function toJson(result: FixResult): object {
  const outcome = (t: TestOutcome | undefined) => (t ? { command: t.command, passed: t.passed, attributed: t.attributed, output: t.output } : null);
  return {
    records: result.records.map((r) => ({
      id: r.record.id,
      title: r.title,
      files: r.files,
      applied: r.applied,
      reason: r.reason,
      sites: r.sites,
      remaining: r.remaining ?? [],
      unconfirmed: r.unconfirmed ?? [],
      pr: r.pr
        ? { ...r.pr, ...("tests" in r.pr ? { tests: outcome(r.pr.tests) } : {}), ...("build" in r.pr ? { build: outcome(r.pr.build) } : {}) }
        : null,
    })),
    build: outcome(result.build),
    tests: outcome(result.tests),
    testsSkipped: result.testsSkipped,
    testsNote: result.testsNote ?? null,
    dryRun: result.dryRun,
    reverted: result.reverted,
    diff: result.diff,
  };
}
