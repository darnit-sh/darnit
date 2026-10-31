import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { checkReport, notCheckedNotes, scan, title, type Coverage, type Hit } from "./check.js";
import * as g from "./git.js";
import { shown, vendorName } from "./detect.js";
import { createPr, defaultBranch, findOpenPr, githubToken, parseRemote, parseSlug } from "./github.js";
import { applyRules, hasRules } from "./packs/apply.js";
import { PLAN_FILE, PLAN_VERSION, serializePlan, type Plan, type PlanOutcome } from "./plan.js";
import { loadRecords } from "./records/load.js";
import type { ChangeRecord } from "./records/schema.js";
import { detectBuildCommand, detectTestCommand, hasPytestSetup, runTests, type TestRun, TIME_LIMIT_MINUTES, unreadSettings } from "./tests.js";
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
  /** Verify each change and write the plan to this folder, instead of committing it. */
  prepare?: string;
};

export type TestOutcome = TestRun & {
  /** What was run: the repo's build or typecheck, or its tests. */
  kind: "build" | "tests";
  /** "change": passed before, failed after. "baseline": already failing before. Neither when it timed out. */
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
  | { state: "build-failed"; build: TestOutcome }
  | { state: "prepared"; build?: TestOutcome | undefined; tests?: TestOutcome | undefined };

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
  /** One result per record, under its `pr`: with --pr or --prepare. */
  pr: boolean;
  /** Where --prepare wrote the plan. */
  plan?: string;
  build?: TestOutcome | undefined;
  tests?: TestOutcome | undefined;
  testsSkipped: boolean;
  /** Why no tests ran, when darnit found a test setup it could not run. */
  testsNote?: string | undefined;
  /** Why no build check ran, when package.json could not be read. */
  buildNote?: string | undefined;
  diff: string;
  reverted: boolean;
  /** What check read and did not read, as in `check`. */
  coverage: Coverage;
  /** Whether check lists model names outside the call sites (possibly affected values, other mentions), which fix leaves alone. */
  namesElsewhere: boolean;
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
const LOCAL = "this file also sends calls to a private address";

/** Why a record whose files were all held was not rewritten: a look-alike client, a private address, or both. */
function heldReason(held: readonly Site[]): string {
  const files = new Set(held.map((h) => h.file)).size === 1 ? "this file" : "each of these files";
  const lookalike = held.some((h) => h.note === MIXED);
  const local = held.some((h) => h.note !== MIXED);
  if (lookalike && local) return `${files} also calls another provider or a private address, so the rewrite would change those calls too`;
  if (local) return `${files} sends calls to a private address, which may not be OpenAI`;
  return `${files} also calls another provider through the same methods, so the rewrite would change those calls too`;
}

const NOT_COVERED = "the rewrite rules don't cover this call shape yet";

async function groupHits(root: string, only: string[] | undefined): Promise<{ groups: Group[]; coverage: Coverage; namesElsewhere: boolean }> {
  const packs = new Map((await loadRecords()).map((l) => [l.record.id, l.packDir]));
  for (const id of only ?? []) if (!packs.has(id)) throw new Refusal(`unknown change record: ${id}`);
  const { hits, foreign, coverage, values, mentions } = await checkReport(root);
  const key = (h: Hit) => `${h.record.id}\0${h.file}`;
  const mixed = new Set(foreign.map(key));
  // A server at a private address may not accept the new parameter, so its calls, and the rest of its file, go to a human.
  const local = new Set(hits.filter((h) => h.local).map(key));
  const byId = new Map<string, Group>();
  for (const hit of hits) {
    if (only && !only.includes(hit.record.id)) continue;
    const group = byId.get(hit.record.id) ?? { record: hit.record, packDir: packs.get(hit.record.id)!, files: [], sites: 0 };
    if (mixed.has(key(hit)) || local.has(key(hit))) {
      const note = hit.local ? `sent to ${hit.local.map(shown).join(" or ")}, which may not be OpenAI` : mixed.has(key(hit)) ? MIXED : LOCAL;
      (group.held ??= []).push({ file: hit.file, line: hit.line, note });
    } else {
      if (!group.files.includes(hit.file)) group.files.push(hit.file);
      group.sites++;
    }
    byId.set(hit.record.id, group);
  }
  return { groups: [...byId.values()], coverage, namesElsewhere: values.length + mentions.length > 0 };
}

// Bytes, not text: a file that is not UTF-8 must come back as it was.
async function snapshotOf(root: string, files: readonly string[]): Promise<Map<string, Buffer>> {
  const snap = new Map<string, Buffer>();
  for (const f of files) snap.set(f, await readFile(join(root, f)));
  return snap;
}

async function restore(root: string, snap: Map<string, Buffer>): Promise<void> {
  for (const [f, bytes] of snap) await writeFile(join(root, f), bytes);
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
  for (const [f, bytes] of before) if (!(await readFile(join(dir, f))).equals(bytes)) changed.push(f);
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
    `needs ${pkg} >= ${min}, this repo has ${found.version} (${shown(found.from)}); upgrade it first`;

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

/**
 * Runs a check; on failure puts the files back and runs it again to say whether the change was the cause.
 * A run that timed out checked nothing, so its files go back with no verdict, and no second run when it was the first.
 */
async function testAndAttribute(root: string, command: string, snap: Map<string, Buffer>, kind: TestOutcome["kind"]): Promise<TestOutcome> {
  const outcome: TestOutcome = { ...(await runTests(root, command)), kind };
  if (!outcome.passed) {
    const changed = await snapshotOf(root, [...snap.keys()]);
    await restore(root, snap);
    if (outcome.timedOut) return outcome;
    const again = await runTests(root, command);
    if (again.timedOut) return { ...outcome, timedOut: true };
    outcome.attributed = again.passed ? "change" : "baseline";
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
async function runChecks(root: string, commands: Commands, snap: Map<string, Buffer>): Promise<{ build?: TestOutcome; tests?: TestOutcome }> {
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
  if (opts.prepare !== undefined) {
    if (opts.pr) throw new Refusal("--prepare and --pr can't be combined: --prepare runs the repository's code, so it never pushes");
    if (opts.dryRun) throw new Refusal("--prepare and --dry-run can't be combined: --prepare writes a plan");
    if (opts.repo) throw new Refusal("--prepare and --repo can't be combined: --prepare opens no pull request");
    // The system keeps darnit's starting environment readable by everything it starts, so no unsetting helps.
    const held = g.CREDENTIALS.find((k) => process.env[k]?.trim());
    if (held) throw new Refusal(`${held} is set; --prepare runs the repository's code, so its job must not hold a token. Run it in a job without one and publish from another`);
    // `git config` still reads this file in place of the others, so it is refused rather than searched.
    if (process.env.GIT_CONFIG?.trim()) throw new Refusal("GIT_CONFIG is set; the repository's code can read darnit's environment and the git config it names, so unset it for --prepare");
  }
  const color = opts.color ?? false;
  const dryRun = opts.dryRun ?? false;
  if (!dryRun && !(await g.isRepo(root))) {
    throw new Refusal("not a checked-out git repository; darnit only edits files it can undo. Use --dry-run to preview.");
  }
  if (!dryRun && !(await g.hasCommit(root))) {
    throw new Refusal("the current branch has no commits yet; commit your files first. Use --dry-run to preview.");
  }
  if (opts.prepare !== undefined) {
    const saved = await g.savedCredential(root);
    if (saved) {
      throw new Refusal(
        `git config holds ${HOLDS[saved]}, in this repository or passed in darnit's environment; --prepare runs the repository's code, so ${saved === "header" ? "check out with persist-credentials: false" : "remove it"}`,
      );
    }
    await startPlan(root, opts.prepare);
  }

  const { groups, coverage, namesElsewhere } = await groupHits(root, opts.only);
  const records: RecordResult[] = [];
  const applicable: Group[] = [];
  for (const grp of groups) {
    const reviewed = grp.record.status === "reviewed";
    const mechanical = grp.record.classification === "mechanical";
    const clean = grp.files.length > 0;
    const ready = reviewed && mechanical && clean && (await hasRules(grp.packDir));
    const gate = ready ? await versionGate(root, grp) : { unconfirmed: [] };
    const applied = ready && !gate.blocked;
    const reason =
      grp.record.status === "candidate"
        ? "unreviewed change record"
        : !mechanical
          ? "migration not yet automated; see the record notes"
          : !reviewed
            ? "checked by a parser, not yet read by a person"
            : !clean
              ? heldReason(grp.held ?? [])
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
  const pr = opts.pr === true || opts.prepare !== undefined;
  const base: FixResult = { records, dryRun, pr, testsSkipped: opts.noTest ?? false, diff: "", reverted: false, coverage, namesElsewhere };
  if (applicable.length === 0) return opts.prepare !== undefined ? prepare(root, [], base, {}, opts.prepare, opts.version) : base;

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
  const unread = opts.noTest ? undefined : await unreadSettings(root);
  const skipped = unread && `${unread} could not be read`;
  if (unread === "package.json" && applicable.some((grp) => grp.files.some((f) => COMPILED.test(f)))) base.buildNote = skipped;
  if (!commands.tests && !opts.noTest) {
    // A package.json that was not read already explains it; Python may well be there.
    const noPython = unread !== "package.json" && (await hasPytestSetup(root)) && "found a pytest setup but no python3 or python on PATH";
    if (skipped && noPython) base.testsNote = `${skipped}; ${noPython}`;
    else if (skipped) base.testsNote = `${skipped}; pass the command with --test`;
    else if (noPython) base.testsNote = noPython;
  }
  if (pr && !opts.allowDirty && !(await g.isClean(root))) {
    throw new Refusal("uncommitted changes in the working tree; commit or stash them, or pass --allow-dirty");
  }
  // Only files git can put back are edited; --allow-dirty tolerates edits elsewhere, never in these.
  const wanted = [...new Set(applicable.flatMap((grp) => grp.files))];
  const why = g.uncommittedReasons(await g.uncommitted(root, wanted), "darnit needs to edit");
  if (why.length > 0) throw new Refusal(`${why.join("; ")}, or preview with --dry-run`);
  if (opts.prepare !== undefined) return prepare(root, applicable, base, commands, opts.prepare, opts.version);
  if (opts.pr) return pullRequests(root, applicable, base, commands, opts);

  const snap = await snapshotOf(root, wanted);
  const touched: string[] = [];
  try {
    for (const grp of applicable) {
      for (const f of settle(resultOf(grp), await applyAndVerify(root, grp), grp.held)) if (!touched.includes(f)) touched.push(f);
    }
    if (touched.length === 0) return base;
    const { build, tests } = await runChecks(root, commands, snap);
    const reverted = failed(build) || failed(tests);
    return { ...base, build, tests, diff: reverted ? "" : await g.diff(root, touched, color), reverted };
  } catch (err) {
    await restore(root, snap);
    throw err;
  }
}

/** Runs the checks on one rewritten group, as --pr and --prepare both do. A failure, which has put the files back, goes on the record. */
async function checkGroup(root: string, commands: Commands, snap: Map<string, Buffer>, result: RecordResult) {
  const { build, tests } = await runChecks(root, commands, snap);
  if (failed(build)) result.pr = { state: "build-failed", build: build! };
  else if (failed(tests)) result.pr = { state: "tests-failed", tests: tests! };
  return { build, tests, passed: !failed(build) && !failed(tests) };
}

const HOLDS: Record<g.Credential, string> = {
  header: "an http extraheader, where actions/checkout saves its token",
  url: "a URL with a user name or password, where a token can sit",
};

/** `path` with every link resolved, as far as it exists. */
async function resolved(path: string): Promise<string> {
  return (await realpath(path).catch(() => undefined)) ?? join(await resolved(dirname(path)), basename(path));
}

/** Refuses a plan folder inside the repository or one planFolder refuses, then removes an earlier plan. */
async function startPlan(root: string, dir: string): Promise<void> {
  const inside = relative(await realpath(await g.topLevel(root)), await resolved(dir));
  if (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) {
    throw new Refusal(`${dir} is inside the repository, where its code can change the plan and git sees it as a change; give --prepare a folder outside it`);
  }
  await planFolder(dir);
  await rm(join(dir, PLAN_FILE), { force: true });
}

/** Refuses a plan folder that is a link, not a folder, or holds anything but an earlier plan. */
async function planFolder(dir: string): Promise<void> {
  const info = await lstat(dir).catch(() => undefined);
  if (!info) return;
  if (!info.isDirectory()) throw new Refusal(`${dir} is ${info.isSymbolicLink() ? "a symbolic link" : "not a folder"}; give --prepare a new or empty folder`);
  const entries = await readdir(dir);
  const earlier = entries.length === 1 && entries[0] === PLAN_FILE && (await lstat(join(dir, PLAN_FILE))).isFile();
  if (entries.length > 0 && !earlier) throw new Refusal(`${dir} is not empty and holds no earlier plan; give --prepare a new or empty folder`);
}

/** Why a change's build or tests did not run, in the words of the pull request body. */
const notRunNotes = (changed: readonly string[], base: FixResult) => ({
  testsNote: base.testsSkipped ? "skipped with --no-test" : base.testsNote,
  // A build only runs for JavaScript and TypeScript changes, so only those were skipped.
  buildNote: base.testsSkipped && changed.some((f) => COMPILED.test(f)) ? "skipped with --no-test" : base.buildNote,
});

const planOutcome = (t: TestOutcome | undefined): PlanOutcome | null =>
  t ? { command: t.command, passed: t.passed, attributed: t.attributed ?? null, notChecked: t.notChecked ?? false, timedOut: t.timedOut, output: t.output } : null;

// What --pr does for each change up to the commit, on the commit the tree is at. The patch is taken before the
// repository's build and tests run, so it holds darnit's change only, and the files go back after each change.
async function prepare(root: string, groups: Group[], base: FixResult, commands: Commands, dir: string, version = "dev"): Promise<FixResult> {
  const plan: Plan = { version: PLAN_VERSION, darnit: version, base: await g.head(root), groups: [] };
  let anyFailed = false;
  for (const grp of groups) {
    const result = base.records.find((r) => r.record.id === grp.record.id)!;
    const snap = await snapshotOf(root, grp.files);
    try {
      const changed = settle(result, await applyAndVerify(root, grp), grp.held);
      if (changed.length === 0) continue;
      const patch = await g.patch(root, changed);
      const { build, tests, passed } = await checkGroup(root, commands, snap, result);
      if (passed) result.pr = { state: "prepared", build, tests };
      anyFailed ||= !passed;
      const notes = notRunNotes(changed, base);
      plan.groups.push({
        id: grp.record.id,
        files: changed,
        patch,
        build: planOutcome(build),
        buildNote: build ? null : (notes.buildNote ?? null),
        tests: planOutcome(tests),
        testsNote: tests ? null : failed(build) ? "the build failed first" : (notes.testsNote ?? "no test command found in this repository"),
      });
    } finally {
      await restore(root, snap);
    }
  }
  const text = serializePlan(plan, new Set((await loadRecords()).map((l) => l.record.id)));
  // The repository's code ran since the folder was checked: a link in its place, or a plan.json, file or link, is never written through.
  await mkdir(dir, { recursive: true });
  if (!(await lstat(dir)).isDirectory()) throw new Refusal(`${dir} became a link during the run; no plan written`);
  await writeFile(join(dir, PLAN_FILE), text, { flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
    throw err.code === "EEXIST" ? new Refusal(`${join(dir, PLAN_FILE)} appeared during the run; no plan written`) : err;
  });
  return { ...base, reverted: anyFailed, plan: join(dir, PLAN_FILE) };
}

// One branch, one test run and one pull request per change. The working tree is
// left exactly as it was found, on the branch it was found on.
async function pullRequests(root: string, groups: Group[], base: FixResult, commands: Commands, opts: FixOptions): Promise<FixResult> {
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
      const { build, tests, passed } = await checkGroup(root, commands, snap, result);
      if (!passed) {
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
        ...notRunNotes(changed, base),
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

const longestBacktickRun = (s: string) => Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length));

/**
 * Text from the repository (a file name, a command) as one code span that GitHub shows literally:
 * control characters are written out (a newline as \\n), and the fence is longer than any backtick run inside.
 */
function code(text: string): string {
  // eslint-disable-next-line no-control-regex
  const t = text.replace(INVISIBLE, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => JSON.stringify(c).slice(1, -1));
  const fence = "`".repeat(longestBacktickRun(t) + 1);
  const pad = /^[` ]|[` ]$/.test(t) ? " " : "";
  return `${fence}${pad}${t}${pad}${fence}`;
}

/**
 * Text from the repository on its way to a terminal: control characters go, and color codes too unless `color`.
 * In GitHub Actions it is fenced by a one-time token so no line of it runs as a workflow command, while
 * darnit's own annotations printed outside it still work.
 */
export function forTerminal(text: string, color = false, env = process.env): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(color ? /\u001b\[[0-9;]*m|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g : /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (m) =>
    m.length > 1 ? m : "",
  );
  if (env.GITHUB_ACTIONS !== "true") return clean;
  const token = randomUUID();
  return `::stop-commands::${token}\n${clean}\n::${token}::`;
}

/** JSON on its way out: `#`, which only a string can hold, as `\u0023`, so no `##[` in it runs as a workflow command. Safe per chunk. */
export const forJson = (json: string) => json.replaceAll("#", "\\u0023");

/** Verbatim vendor text: GitHub renders a code span as literal text, so no links, HTML or mentions. */
const plain = (text: string) => {
  const t = text.replaceAll("`", "'").replace(/\s+/g, " ").trim();
  return t ? `\`${t}\`` : "";
};

// Characters GitHub can turn into something live: mentions, references, URLs, emoji, math,
// commit links, custom references like ABC-123, HTML and entities.
const RISKY = /[@#/$]|:\S|www[.)\]]?$|www\.|[0-9a-f]{7}|[A-Za-z]+-\d|^[<&]/i;
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u061C\uFEFF]/g;
const escapeMarkdown = (s: string) => s.replace(/[\\`*_[\]()<>!|~{}&#$]/g, (c) => `\\${c}`);

/**
 * Reviewed record text as readable prose that GitHub cannot turn into anything live. Plain words
 * get Markdown escaped; a word GitHub could link, ping, reference or render shows as a small code
 * span instead, which GitHub never touches and which copies exactly. Existing `code` is kept.
 * Each rule was checked against GitHub's own renderer.
 */
export function prose(text: string): string {
  const clean = text.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  // A cap keeps every pattern below fast on any input; real notes are a few sentences.
  const capped = clean.length > 2000 ? `${clean.slice(0, 2000)}…` : clean;
  return capped
    .split(/(`[^`]+`)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .split(" ")
            .map((word) => {
              const [, lead = "", core = "", trail = ""] = /^([("'[]*)(.*?)([.,;:!?)"'\]]*)$/.exec(word) ?? [];
              if (!RISKY.test(word) || !core) return escapeMarkdown(word);
              return `${escapeMarkdown(lead)}\`${core.replaceAll("`", "")}\`${escapeMarkdown(trail)}`;
            })
            .join(" "),
    )
    .join("")
    .replace(/^(\d+)([.)])/, "$1\\$2")
    .replace(/^([-+=])/, "\\$1");
}

/** A code block fence no line of `text` can close. */
const fence = (text: string) => "`".repeat(Math.max(3, longestBacktickRun(text) + 1));

export type PrEvidence = {
  build?: TestOutcome | undefined;
  tests?: TestOutcome | undefined;
  remaining?: readonly Site[] | undefined;
  testsNote?: string | undefined;
  buildNote?: string | undefined;
  unconfirmed?: readonly string[] | undefined;
};

export function prBody(record: ChangeRecord, files: readonly string[], version: string, evidence: PrEvidence = {}): string {
  const { build, tests, remaining = [], testsNote, buildNote, unconfirmed = [] } = evidence;
  const source = record.sources[0]!;
  return [
    prose(record.notes?.migration ?? title(record)),
    "",
    "## Why",
    `${vendorName(record.vendor)} announced this change on ${record.announcedAt}: ${source.url}`,
    ...(source.quoteId ? [`> ${plain(source.quoteId)}`] : []),
    "",
    "## What changed",
    ...files.map((f) => `- ${code(f)}`),
    "",
    "## Verified",
    ...(build
      ? [
          build.notChecked
            ? `- [ ] ${code(build.command)} already fails without this change, so it could not check it`
            : `- [${build.passed ? "x" : " "}] ${code(build.command)} ${build.passed ? "passed" : "failed"}`,
        ]
      : buildNote
        ? [`- [ ] build not checked: ${buildNote}`]
        : []),
    tests ? `- [${tests.passed ? "x" : " "}] ${code(tests.command)} ${tests.passed ? "passed" : "failed"}` : `- [ ] ${testsNote ? `tests not run: ${testsNote}` : "no test command found in this repository"}`,
    ...(tests?.output ? ["", "<details><summary>test output</summary>", "", fence(tests.output), tests.output, fence(tests.output), "", "</details>"] : []),
    "",
    ...(remaining.length > 0
      ? ["## Needs a human", "These call sites were found but not rewritten:", ...remaining.map((r) => `- ${code(`${r.file}:${r.line}`)}${r.note ? `: ${prose(r.note)}` : ""}`), ""]
      : []),
    "## Not verified",
    ...unconfirmed.map((u) => `- This change needs ${u}; darnit could not find the version this repository uses.`),
    "- No generated regression tests yet; the checks above are the repository's own.",
    "- Request options built elsewhere and passed in as a variable are not followed.",
    ...(record.notes?.edgeCases ?? []).map((e) => `- ${prose(e)}`),
    "",
    "---",
    `darnit ${version}, change record [\`${record.id}\`](${recordUrl(record.id)})`,
    "",
  ].join("\n");
}

// Opened pull requests can't be edited later, so the footer links a darnit.sh path
// that can be served by a real page one day. The record's folder is named from its id
// (packs/<vendor>/<date>-<slug>), which records.test.ts enforces.
function recordUrl(id: string): string {
  const [vendor, date, slug] = id.split(":");
  return `https://darnit.sh/changes/${vendor}/${date}-${slug}`;
}

export function exitCodeFor(result: FixResult): 0 | 1 {
  if (failed(result.build) || failed(result.tests)) return 1;
  return result.records.some((r) => r.pr?.state === "tests-failed" || r.pr?.state === "build-failed") ? 1 : 0;
}

function testLine(t: TestOutcome): string {
  if (t.passed) return `${t.kind}: ${t.command} passed`;
  if (t.notChecked) return `${t.kind}: ${t.command} already fails without the change, so it could not check it; change kept`;
  if (t.timedOut) {
    return `${t.kind}: ${t.command} timed out after ${TIME_LIMIT_MINUTES} minutes; files put back, since a run that did not finish can't check the change. Rerun with --no-test to apply it without the tests or the build check.${t.output ? `\n${t.output}` : ""}`;
  }
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
    else if (r.pr.state === "prepared") {
      const verified = [r.pr.build, r.pr.tests].some((c) => c?.passed);
      lines.push(`✓ ${r.title}: ${verified ? "verified, in the plan" : "in the plan, not verified"}`);
      for (const line of checkLines(result, r.pr.build, r.pr.tests)) lines.push(`  ${line}`);
    }
    else if (r.pr.state === "exists") lines.push(`= ${r.title}: pull request already open ${r.pr.url}`);
    else if (r.pr.state === "skipped") lines.push(`- ${r.title}: skipped, ${r.pr.reason}`);
    else lines.push(`✗ ${r.title}: nothing pushed\n  ${testLine(r.pr.state === "build-failed" ? r.pr.build : r.pr.tests)}`);
    // Once put back, every call site is unfixed again, not only the ones the rules missed.
    const putBack = !r.pr && result.reverted;
    if (!putBack || !r.applied) for (const s of r.remaining ?? []) lines.push(`  needs a human: ${shown(s.file)}:${s.line}${s.note ? ` (${s.note})` : ""}`);
    if (r.applied) for (const u of r.unconfirmed ?? []) lines.push(`  could not confirm ${u}`);
  }
  const notChecked = notCheckedNotes(result.coverage);
  // A bare "Nothing to fix." would read as a clean repository; as in check, only when nothing else was found or left unread.
  if (lines.length === 0) {
    lines.push(
      result.namesElsewhere
        ? "No call sites to fix. darnit check lists the model names it found elsewhere, which fix leaves alone."
        : notChecked.length > 0
          ? "Nothing to fix in the files darnit checked."
          : "Nothing to fix.",
    );
  }
  const applied = result.records.some((r) => r.applied);
  if (result.dryRun) {
    if (applied) lines.push("dry run: nothing written");
  } else if (result.pr) {
    // Per-record lines already carry the test result.
    if (result.plan) lines.push(`plan written to ${result.plan}`);
  } else if (applied) {
    lines.push(...checkLines(result, result.build, result.tests));
  }
  return [...lines, ...notChecked].join("\n");
}

/** What a build and tests found, or why they did not run. */
function checkLines(result: FixResult, build: TestOutcome | undefined, tests: TestOutcome | undefined): string[] {
  return [
    ...(build ? [testLine(build)] : result.buildNote ? [`build: none run (${result.buildNote})`] : []),
    ...(tests
      ? [testLine(tests)]
      : failed(build)
        ? []
        : [result.testsSkipped ? "tests: skipped" : result.testsNote ? `tests: none run (${result.testsNote})` : "tests: none found (no test script or pytest setup)"]),
  ];
}

export function toJson(result: FixResult): object {
  const outcome = (t: TestOutcome | undefined) =>
    t ? { kind: t.kind, command: t.command, passed: t.passed, attributed: t.attributed, notChecked: t.notChecked ?? false, timedOut: t.timedOut, output: t.output } : null;
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
    buildNote: result.buildNote ?? null,
    dryRun: result.dryRun,
    reverted: result.reverted,
    diff: result.diff,
    scanned: result.coverage,
  };
}
