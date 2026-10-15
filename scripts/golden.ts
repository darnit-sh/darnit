import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

// Scans pinned real repositories with the built CLI and compares each result with test/golden/<owner>_<name>.txt.
// Usage: npm run golden [-- --update] [--all] [--dir <clones>] [--out <dir for changed results>]
// Fails on any difference, a repo that cannot be fetched, darnit exiting 2 or writing to stderr, or a repo count
// that does not match repos.tsv. Facts only are stored (paths, lines, model names, record ids), never their code.

const { values: args } = parseArgs({
  options: {
    update: { type: "boolean", default: false },
    all: { type: "boolean", default: false },
    dir: { type: "string", default: join(homedir(), ".cache", "darnit-golden") },
    out: { type: "string", default: join(tmpdir(), "darnit-golden-update") },
  },
});
const GOLDEN = resolve("test/golden");
const CLI = resolve("dist/cli.js");
const ci = !!process.env.GITHUB_ACTIONS;
const errors: string[] = [];
const fail = (message: string) => {
  errors.push(message);
  console.log(ci ? `::error::${message}` : `error: ${message}`);
};

const rows = readFileSync(join(GOLDEN, "repos.tsv"), "utf8").trimEnd().split("\n").slice(1).map((line, i) => {
  const [repo = "", sha = "", slice = "", shape = ""] = line.split("\t");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[0-9a-f]{40}$/.test(sha) || !/^(yes|no)$/.test(slice) || !shape)
    throw new Error(`repos.tsv line ${i + 2} is not repo, 40-character SHA, yes or no, shape: ${line}`);
  return { repo, sha, slice: slice === "yes", file: `${repo.replace("/", "_")}.txt` };
});
const picked = rows.filter((r) => args.all || r.slice);

const git = (cwd: string, ...a: string[]) =>
  spawnSync("git", a, { cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 1 << 30, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" } });
const quiet = (dir: string, ...a: string[]) => {
  const run = git(dir, ...a);
  return run.status === 0 ? run.stdout.trim() : undefined;
};
const pinned = (dir: string, sha: string) => existsSync(join(dir, ".git")) && quiet(dir, "rev-parse", "HEAD") === sha && quiet(dir, "status", "--porcelain") === "";

/** The clone at its pinned SHA with no changes, fetched again unless the cached copy is exactly that. */
function clone(repo: string, sha: string): string | undefined {
  const dir = join(args.dir, repo.replace("/", "_"));
  if (pinned(dir, sha)) return dir;
  console.log(`fetching ${repo} at ${sha}`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    let why = "";
    for (const step of [["init", "-q"], ["fetch", "-q", "--depth", "1", `https://github.com/${repo}.git`, sha], ["-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD"]]) {
      const run = git(dir, ...step);
      if (run.status !== 0) {
        why = (run.stderr || run.error?.message || `git ${step[0]} failed`).trim();
        break;
      }
    }
    if (!why && pinned(dir, sha)) return dir;
    console.log(`fetch ${repo} attempt ${attempt} failed: ${why || "checkout is not the pinned SHA with no changes"}`);
  }
  fail(`could not fetch ${repo} at ${sha}, not caused by this PR, rerun`);
}

type Report = {
  scanned: { files: number; otherFiles?: number; foreign?: number; foreignAt?: string[]; tooLarge?: string[]; skipped?: { path: string; reason: string }[] };
  hits: { id: string; file: string; line: number; column: number; localAddresses?: string[] }[];
  possiblyAffected: { id: string; file: string; line: number; column: number; model: string; localAddresses?: string[] }[];
  mentions: { id: string; file: string; line: number; model: string }[];
};

/** One finding per line, in the order darnit reports them. */
function lines(exit: number, r: Report): string {
  const s = r.scanned;
  const local = (h: { localAddresses?: string[] }) => (h.localAddresses ? ` local=${h.localAddresses.join(",")}` : "");
  return [
    `exit ${exit}`,
    `scanned files=${s.files} otherFiles=${s.otherFiles ?? 0} foreign=${s.foreign ?? 0} tooLarge=${s.tooLarge?.length ?? 0} skipped=${s.skipped?.length ?? 0}`,
    ...r.hits.map((h) => `H ${h.file}:${h.line}:${h.column} ${h.id}${local(h)}`),
    ...r.possiblyAffected.map((p) => `P ${p.file}:${p.line}:${p.column} ${p.model} ${p.id}${local(p)}`),
    ...r.mentions.map((m) => `M ${m.file}:${m.line} ${m.model} ${m.id}`),
    ...(s.foreignAt ?? []).map((f) => `F ${f}`),
    ...(s.tooLarge ?? []).map((t) => `T ${t}`),
    ...(s.skipped ?? []).map((k) => `S ${k.path} ${k.reason}`),
    "",
  ].join("\n");
}

const known = new Set(rows.map((r) => r.file));
for (const f of readdirSync(GOLDEN)) if (f.endsWith(".txt") && !known.has(f)) fail(`test/golden/${f} is for a repo not in repos.tsv`);

let compared = 0;
const diffs: string[] = [];
let added = 0;
let removed = 0;
for (const { repo, sha, file } of picked) {
  const dir = clone(repo, sha);
  if (!dir) continue;
  const run = spawnSync(process.execPath, [CLI, "check", "--json"], {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    env: { ...process.env, DARNIT_NO_UPDATE_CHECK: "1" },
  });
  if (run.status !== 0 && run.status !== 1) {
    fail(`darnit exited ${run.status ?? run.signal} on ${repo}: ${run.stderr || run.error?.message || ""}`.trim());
    continue;
  }
  if (run.stderr) {
    fail(`darnit wrote to stderr on ${repo}: ${run.stderr.trim()}`);
    continue;
  }
  const actual = lines(run.status, JSON.parse(run.stdout) as Report);
  compared++;
  const stored = join(GOLDEN, file);
  if (args.update) writeFileSync(stored, actual);
  else if (!existsSync(stored) || readFileSync(stored, "utf8") !== actual) {
    mkdirSync(args.out, { recursive: true });
    writeFileSync(join(args.out, file), actual);
    const raw = git(".", "diff", "--no-index", "--no-color", "--", existsSync(stored) ? stored : "/dev/null", join(args.out, file)).stdout;
    const diff = `--- test/golden/${file}\n+++ new ${file}\n${raw.slice(raw.indexOf("\n@@") + 1)}`;
    diffs.push(diff);
    added += diff.split("\n").filter((l) => /^\+[A-Za-z]/.test(l)).length;
    removed += diff.split("\n").filter((l) => /^-[A-Za-z]/.test(l)).length;
    fail(`${repo} result differs from test/golden/${file}`);
  }
  console.log(`${repo}: ${actual.split("\n").length - 3} findings`);
}

if (compared !== picked.length) fail(`compared ${compared} repos, repos.tsv lists ${picked.length}`);
const summary = [`Compared ${compared} of ${picked.length} pinned repositories with test/golden.`];
if (diffs.length > 0) {
  const all = diffs.join("").split("\n");
  summary.push(
    "",
    "```diff",
    ...all.slice(0, 200),
    "```",
    `+${added} -${removed} lines in ${diffs.length} repos${all.length > 200 ? ` (first 200 of ${all.length} diff lines shown)` : ""}.`,
    `New results are in ${args.out}.`,
    "If the change is intended, run `npm run golden -- --update` (or unzip the golden-update artifact into test/golden) and commit the result.",
  );
}
if (errors.length > 0) summary.push("", ...errors.map((e) => `- ${e}`));
console.log(summary.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`);
process.exitCode = errors.length > 0 ? 1 : 0;
