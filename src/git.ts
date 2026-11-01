import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { cleanEnv, firstFive, onPath } from "./detect.js";
import { envToken } from "./github.js";
import { Refusal } from "./refusal.js";

const exec = promisify(execFile);

// darnit's GitHub credentials open the pull request; the repository's own commands never get them.
export const CREDENTIALS = ["GITHUB_TOKEN", "GH_TOKEN"];

// The repository's config can name programs git would run inside darnit's own calls, even with
// `--no-test`. These pins, on every call, turn off the ones keyed by a fixed name: no hooks (on
// commit or checkout), no fsmonitor, no gpg signing of a commit or on push, and no recursion into a
// submodule on push (which would run the submodule's own remote helper, with darnit's push
// environment and token; `push.recurseSubmodules=no` overrides a repository's `submodule.recurse=true`
// too). Clean/smudge/process filters are keyed by driver name, so `filterConfig` empties each one git
// would use; an external diff and textconv are turned off per diff, and a submodule's own status
// (which runs its filters) is skipped, both in `git`. A pager never starts because darnit captures
// git's output rather than writing to a terminal. git also never sees darnit's credentials and takes
// file names literally, never as patterns. SECURITY.md lists the keys that still apply (an ssh
// command, credential helper or proxy on a call to origin, a remote helper program).
const UNTRUSTED_REPO = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "commit.gpgSign=false",
  "-c", "push.gpgSign=false",
  "-c", "push.recurseSubmodules=no",
];

// darnit turns off the programs a repository's config names by passing git config in the child's
// environment, which git reads only from this version on; an older git would ignore it and run them.
export const MIN_GIT: [number, number] = [2, 31];
const gitChecked = new Map<string, Promise<void>>();
/** Refuses the run on a git too old to read the environment config darnit's pins rely on. `gitBin` defaults to bare `git` for calls in darnit's own job; --publish passes the absolute path it resolved, with `env` the clone's clean environment so no trace or token-bearing variable reaches this call either. */
export function ensureGitVersion(gitBin = "git", env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const checked = gitChecked.get(gitBin);
  if (checked) return checked;
  const run = exec(gitBin, ["version"], { env }).then(({ stdout }) => {
    const m = /^git version (\d+)\.(\d+)/.exec(stdout.trim());
    const [maj, min] = [Number(m?.[1]), Number(m?.[2])];
    if (!m || maj < MIN_GIT[0] || (maj === MIN_GIT[0] && min < MIN_GIT[1])) {
      throw new Error(`darnit needs git ${MIN_GIT.join(".")} or newer to run git safely against a repository; this is ${stdout.trim() || "an unknown version"}`);
    }
  });
  gitChecked.set(gitBin, run);
  return run;
}

// The git commands darnit runs that apply a clean, smudge or process filter to content: `add` and
// `commit` and `status` and `diff` on the index side, `checkout` (discard) and `switch` on the worktree side.
const FILTERED = new Set(["add", "status", "commit", "diff", "checkout", "switch"]);
// More filter drivers than darnit will turn off one by one; past this it refuses rather than run them.
const FILTER_CAP = 256;
const FILTER_VARS = [".clean", ".smudge", ".process"];

/**
 * The git config entries that turn off every clean/smudge/process filter git would apply in `root`,
 * from any scope. Setting a driver's `process` to empty is enough: git runs a configured process
 * filter in place of that driver's clean and smudge, and an empty one marked optional passes content
 * through unchanged, so one pin per driver covers all three directions. A driver's name can hold any
 * byte, including the `=` that `-c name=value` splits on, so these go in the child's environment (see
 * `configEnv`), where key and value stay apart. The listing uses `--list`, not a `--get-regexp`
 * pattern: git's regex runs under the locale and its `.` does not match a byte such as 0xff, so a
 * hostile driver name would be dropped and its filter left live. darnit picks the filter keys itself,
 * by bytes (forcing LC_ALL=C so nothing else shifts). Fails closed: a listing that errors, overflows
 * its buffer, names more than `FILTER_CAP` drivers, or holds a name that is not valid UTF-8 (which git
 * writes raw but darnit cannot pass back through an environment it can only write as UTF-8) throws
 * rather than leave a filter unpinned.
 */
async function filterConfig(root: string, env: NodeJS.ProcessEnv): Promise<[string, string][]> {
  let raw: Buffer;
  try {
    ({ stdout: raw } = await exec("git", [...UNTRUSTED_REPO, "config", "-z", "--name-only", "--list"], { cwd: root, env: { ...env, LC_ALL: "C", LANG: "C" }, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }));
  } catch (err) {
    // git config exits 1 with no output only when there is no config to list. Any other failure (a read
    // error, or output past the buffer) must not pass for "none", or a filter runs.
    const e = err as { code?: number | string; stdout?: Buffer };
    if (e.code === 1 && (e.stdout?.length ?? 0) === 0) raw = Buffer.alloc(0);
    else throw new Error("could not read the repository's git config; refusing to run git against it", { cause: err });
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const names = new Set<string>();
  // Keys are NUL-separated; latin1 keeps every byte, so a driver name of any bytes survives the split.
  for (const key of raw.toString("latin1").split("\0")) {
    const suffix = key.startsWith("filter.") ? FILTER_VARS.find((v) => key.endsWith(v)) : undefined;
    if (suffix === undefined) continue;
    const name = Buffer.from(key.slice("filter.".length, key.length - suffix.length), "latin1");
    try {
      names.add(decoder.decode(name));
    } catch {
      throw new Error("the repository names a git filter driver with bytes that are not valid UTF-8; refusing to run git against it");
    }
  }
  if (names.size > FILTER_CAP) throw new Error(`the repository configures ${names.size} git filter drivers, over darnit's limit of ${FILTER_CAP}; refusing to run git against it`);
  return [...names].flatMap((n): [string, string][] => [[`filter.${n}.process`, ""], [`filter.${n}.required`, "false"]]);
}

/** git config entries as the variables git reads them from, so a key holding `=` is never split. */
function configEnv(entries: readonly (readonly [string, string])[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], n) => {
    env[`GIT_CONFIG_KEY_${n}`] = key;
    env[`GIT_CONFIG_VALUE_${n}`] = value;
  });
  return env;
}

const GITHUB = "https://github.com/";
// git commands that reach origin. git() refuses them without `stall`, which also brings the token.
const REMOTE = new Set(["push", "fetch", "pull", "ls-remote", "clone", "archive", "submodule"]);
// `git remote` subcommands that stay local (`add` unless it fetches); any other may reach origin.
const LOCAL_REMOTE = new Set(["get-url", "set-url", "rename", "remove", "rm", "set-branches", "add"]);
// git's global options that take the next argument as their value.
const VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"]);

// git's own list of the variables that pick a repository, its index and objects, or config local to
// it (GIT_DIR, GIT_INDEX_FILE, GIT_CONFIG_COUNT...). Left in place they would point git() elsewhere.
let repoLocal: Promise<string[]> | undefined;
// The names git 2.40 through 2.47 print, for when git cannot be asked.
const REPO_LOCAL = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_OBJECT_DIRECTORY",
  "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR",
];
const repoLocalVars = () =>
  (repoLocal ??= exec("git", ["rev-parse", "--local-env-vars"]).then(
    ({ stdout }) => {
      const names = stdout.split("\n").filter(Boolean);
      return names.length > 0 ? names : REPO_LOCAL;
    },
    () => REPO_LOCAL,
  ));

/** The environment for git and the repository's own commands: no credentials, nothing that points git elsewhere. */
export async function childEnv(): Promise<NodeJS.ProcessEnv> {
  const env = { ...process.env };
  for (const k of [...CREDENTIALS, ...(await repoLocalVars())]) delete env[k];
  return env;
}

/** The git command `args` runs, after git's global options, and whether it can reach origin. */
function command(args: string[]): { name: string; remote: boolean; at: number } {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i += VALUED.has(args[i]!) ? 2 : 1;
  const [name = "", ...rest] = args.slice(i);
  // An alias set on the command line can stand for any command, so it counts as one that reaches origin.
  const opts = args.slice(0, i);
  if (opts.some((a, j) => /^--config-env=alias\./i.test(a) || (["-c", "--config-env"].includes(a) && /^alias\./i.test(opts[j + 1] ?? "")))) return { name, remote: true, at: i };
  if (name !== "remote") return { name, remote: REMOTE.has(name), at: i };
  const sub = rest.find((a) => !a.startsWith("-"));
  return { name, remote: sub !== undefined && (!LOCAL_REMOTE.has(sub) || (sub === "add" && rest.some((a) => a === "-f" || a === "--fetch"))), at: i };
}

/**
 * `stall` marks a call to origin and bounds it. Git itself ends an HTTP or HTTPS transfer that moves
 * less than a byte a second for that many seconds; the environment beats any `http.<url>.lowSpeed*`
 * config. Any other transport is stopped after four times as long, which can leave its ssh child
 * running. In GitHub Actions the call also gets the token for `site` (see originAuth).
 */
export async function git(root: string, args: string[], stall?: number, site = GITHUB): Promise<string> {
  const { name, remote, at } = command(args);
  if (!stall && remote) throw new Error(`git ${name} reaches origin, so it needs a stall limit`);
  const env: NodeJS.ProcessEnv = { ...(await childEnv()), GIT_LITERAL_PATHSPECS: "1" };
  const config: [string, string][] = [];
  let timeout = 0;
  if (stall) {
    Object.assign(env, { GIT_HTTP_LOW_SPEED_LIMIT: "1", GIT_HTTP_LOW_SPEED_TIME: String(stall) });
    config.push(...originAuth(site));
    // A process timeout would cut a slow but healthy HTTPS push and leave its helper pushing.
    const urls = (await git(root, ["remote", "get-url", "--all", ...(name === "push" ? ["--push"] : []), "origin"])).split("\n").filter(Boolean);
    if (!urls.every((u) => /^https?:\/\//i.test(u))) timeout = stall * 4 * 1000;
  }
  // Read the repository's filters before adding config of our own to the environment.
  if (FILTERED.has(name)) config.push(...(await filterConfig(root, env)));
  if (config.length > 0) Object.assign(env, configEnv(config));
  // No external diff or textconv runs a diff, and neither a diff nor a status descends into a
  // submodule, where it would run a status (and the submodule's own filters) there.
  const inject = name === "diff" ? ["--no-ext-diff", "--no-textconv", "--ignore-submodules=all"] : name === "status" ? ["--ignore-submodules=all"] : [];
  const scoped = inject.length > 0 ? [...args.slice(0, at + 1), ...inject, ...args.slice(at + 1)] : args;
  try {
    const { stdout } = await exec("git", [...UNTRUSTED_REPO, ...scoped], { cwd: root, env, maxBuffer: 64 * 1024 * 1024, timeout });
    return stdout;
  } catch (err) {
    const { killed, stderr } = err as { killed?: boolean; stderr?: string };
    if (stall && (killed || stderr?.includes("Operation too slow"))) {
      throw new Error(`git ${name} timed out after ${killed ? stall * 4 : stall} seconds`, { cause: err });
    }
    throw err;
  }
}

/** True inside a checked-out work tree. In a bare repository or a .git folder git succeeds but prints false. */
export const isRepo = (root: string) =>
  git(root, ["rev-parse", "--is-inside-work-tree"]).then(
    (out) => out.trim() === "true",
    () => false,
  );

export const hasCommit = (root: string) =>
  git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).then(
    () => true,
    () => false,
  );

export const isClean = async (root: string) => (await git(root, ["status", "--porcelain"])).trim() === "";

const currentBranch = async (root: string) => (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();

export const localBranchExists = (root: string, name: string) =>
  git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).then(
    () => true,
    () => false,
  );

export const remoteBranchExists = async (root: string, name: string, site = GITHUB) =>
  (await git(root, ["ls-remote", "--heads", "origin", name], 30, site)).trim() !== "";

export const remoteUrl = async (root: string) => (await git(root, ["remote", "get-url", "origin"])).trim();

export const switchTo = (root: string, ref: string, mode: "existing" | "create" | "detach" = "existing") =>
  git(root, ["switch", "-q", ...(mode === "create" ? ["-c"] : mode === "detach" ? ["--detach"] : []), ref]);

/** Where to come back to: a branch name, or a commit when HEAD is detached. */
export async function position(root: string): Promise<{ ref: string; detached: boolean }> {
  const branch = await currentBranch(root);
  if (branch !== "HEAD") return { ref: branch, detached: false };
  return { ref: (await git(root, ["rev-parse", "HEAD"])).trim(), detached: true };
}

/** Tracked files under `root` with changes, staged or not, relative to `root`. */
export const modified = async (root: string) => (await git(root, ["diff", "--name-only", "-z", "--relative", "HEAD"])).split("\0").filter(Boolean);

/**
 * Tracked files under `root` that git status calls changed, staged or not, relative to `root`. Unlike
 * `modified`, this includes a file whose bytes differ only in what git would normalize, such as line endings.
 */
async function changedFiles(root: string): Promise<string[]> {
  const prefix = (await git(root, ["rev-parse", "--show-prefix"])).trim();
  const entries = (await git(root, ["--no-optional-locks", "status", "--porcelain", "-z", "--untracked-files=no"])).split("\0");
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    // Paths are from the repository root. A rename or copy is followed by its source path, which has no status of its own.
    const paths = /[RC]/.test(entry.slice(0, 2)) ? [entry.slice(3), entries[++i] ?? ""] : [entry.slice(3)];
    for (const p of paths) if (p && p.startsWith(prefix)) out.push(p.slice(prefix.length));
  }
  return out;
}

/** A core setting as git reads a boolean, or undefined when it is not set. */
const coreFlag = (root: string, name: string) =>
  git(root, ["config", "--type=bool", "--get", `core.${name}`]).then(
    (v) => v.trim() === "true",
    () => undefined,
  );

/**
 * Which of `files` (relative to `root`) git could not put back as they are now: changed since HEAD,
 * staged or not, or with no plain committed copy in this repository (untracked, ignored, marked
 * assume-unchanged or skip-worktree, or inside a nested repository or submodule). Lists the whole
 * tree once rather than passing `files` to git, which matches each name against every entry.
 */
export async function uncommitted(root: string, files: readonly string[]): Promise<Uncommitted[]> {
  if (files.length === 0) return [];
  // Git on macOS lists names composed, whatever form the disk gives them in, so they are compared that way there.
  const composed = (await coreFlag(root, "precomposeunicode")) ?? process.platform === "darwin";
  const key = (f: string) => (composed ? f.normalize("NFC") : f);
  const changed = new Set((await changedFiles(root)).map(key));
  // -v tags each entry; "H " is a plain tracked file, anything else is a flag or a conflict git would not restore from.
  const names = (await git(root, ["ls-files", "-v", "-z"])).split("\0").filter((e) => e.startsWith("H ")).map((e) => e.slice(2));
  const tracked = new Set(names.map(key));
  const caseless = (await coreFlag(root, "ignorecase")) ? new Map(names.map((n) => [key(n).toLowerCase(), n])) : undefined;
  return files
    .filter((f) => changed.has(key(f)) || !tracked.has(key(f)))
    .map((file) => {
      const gitName = tracked.has(key(file)) ? undefined : caseless?.get(key(file).toLowerCase());
      return gitName ? { file, gitName } : { file };
    });
}

/** A file git could not put back; `gitName` when git has it under a name that differs only in case. */
export type Uncommitted = { file: string; gitName?: string };

/** Why a command refuses `unsafe`, the files it `would` change ("darnit needs to edit"): one clause each for changed and case-only names. */
export function uncommittedReasons(unsafe: readonly Uncommitted[], would: string): string[] {
  const changed = unsafe.filter((u) => !u.gitName).map((u) => u.file);
  const renamed = unsafe.filter((u) => u.gitName).map((u) => `${u.file} (git has ${u.gitName})`);
  return [
    ...(changed.length > 0 ? [`uncommitted changes in files ${would}: ${firstFive(changed)}; commit or stash them first so git can undo the rewrite`] : []),
    ...(renamed.length > 0 ? [`files ${would} differ only in case from the names git has: ${firstFive(renamed)}; rename them back or commit the rename first`] : []),
  ];
}

/** Puts tracked files back to their committed contents. */
export const discard = async (root: string, files: readonly string[]) => {
  if (files.length > 0) await git(root, ["checkout", "--", ...files]);
};

export const deleteBranch = (root: string, name: string) => git(root, ["branch", "-q", "-D", name]);

export const add = (root: string, files: readonly string[]) => git(root, ["add", "--", ...files]);

/** Commits as the configured user, or as darnit when the machine has no identity (CI runners). */
export async function commit(root: string, subject: string, body: string): Promise<void> {
  const email = await git(root, ["config", "user.email"]).catch(() => "");
  const identity = email.trim() ? [] : ["-c", "user.name=darnit", "-c", "user.email=darnit@users.noreply.github.com"];
  await git(root, [...identity, "commit", "-q", "-m", subject, "-m", body]);
}

/**
 * In GitHub Actions with a token in the environment, a call to origin gets it as git config in its
 * own environment: never on disk or in arguments, sent to `site` only. The empty value first drops
 * any header the checkout saved, since two would reach the server. Elsewhere git's own credentials
 * are used. Known limit: config the repository's own code wrote to .git/config still applies. It
 * can send the header to another server (http.curloptResolve with http.sslVerify false, http.proxy)
 * or hand it to another program (core.sshCommand, credential.helper, core.askPass).
 */
function originAuth(site: string): [string, string][] {
  if (process.env.GITHUB_ACTIONS !== "true") return [];
  const token = envToken();
  if (!token) return [];
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  // The empty value first drops any header the checkout saved, since two would reach the server.
  return [[`http.${site}.extraheader`, ""], [`http.${site}.extraheader`, header]];
}

export const push = (root: string, branch: string, site = GITHUB) => git(root, ["push", "-q", "-u", "origin", branch], 60, site);

export const diff = (root: string, files: readonly string[]) => git(root, ["--no-pager", "diff", "--color=never", "--", ...files]);

const EXTRAHEADER = /^http\.(?:.+\.)?extraheader$/i;
// A user name or password in an http or https URL, where a token can sit.
const URL_USER = /\bhttps?:\/\/[^\s/?#@]*@/i;

/** How git config can hand the repository's code a token: an http extra header, an ssh command, or a URL with a user or password. */
export type Credential = "header" | "ssh" | "url";

const has = (entries: readonly (readonly [string, string])[], key: RegExp) => entries.some(([k]) => key.test(k.trim()));
const credentialIn = (entries: readonly (readonly [string, string])[]): Credential | undefined =>
  has(entries, EXTRAHEADER) ? "header" : has(entries, /^core\.sshcommand$/i) ? "ssh" : entries.some((e) => e.some((t) => URL_USER.test(t))) ? "url" : undefined;

// Config git takes from the environment. git() drops it; the search for a token keeps it, since everything darnit
// starts can read darnit's environment.
const ENV_CONFIG = /^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/;

/** The token git config holds, as git reads it in `root`: every scope, the config in darnit's environment, and every file they include. */
export async function savedCredential(root: string): Promise<Credential | undefined> {
  const env = { ...(await childEnv()), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => ENV_CONFIG.test(k))) };
  const { stdout } = await exec("git", [...UNTRUSTED_REPO, "config", "--list", "-z"], { cwd: root, env, maxBuffer: 64 * 1024 * 1024 });
  return credentialIn(entriesOf(stdout));
}

/** `git config --list -z` output as key and value pairs. */
const entriesOf = (stdout: string) =>
  stdout.split("\0").filter(Boolean).map((e) => {
    const i = e.indexOf("\n");
    return i < 0 ? ([e, ""] as const) : ([e.slice(0, i), e.slice(i + 1)] as const);
  });

export const topLevel = async (root: string) => (await git(root, ["rev-parse", "--show-toplevel"])).trim();

export const head = async (root: string) => (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();

// Settings the repository can set that change a diff's bytes; pinned so two checkouts produce the same patch.
const PINNED_DIFF = ["core.quotePath=false", "diff.suppressBlankEmpty=false", "diff.orderFile=/dev/null"];

/** The pinned `git diff --binary --full-index` of `files` against HEAD, so two checkouts of the same commit print the same bytes. */
export const diffArgs = (files: readonly string[]) => [
  ...PINNED_DIFF.flatMap((c) => ["-c", c]),
  "--no-pager", "diff", "--binary", "--full-index", "--no-color", "--no-ext-diff", "--no-textconv", "--relative",
  "--src-prefix=a/", "--dst-prefix=b/", "--unified=3", "--inter-hunk-context=0", "--diff-algorithm=myers", "--indent-heuristic",
  "HEAD", "--", ...files,
];

/** `files` (relative to `root`) against HEAD as `git diff --binary` prints them, with paths relative to `root`. */
export const patch = (root: string, files: readonly string[]) => git(root, diffArgs(files));

/** How git prints the token: an http auth header for github.com, never on disk or in an argument. */
const authHeader = (token: string) => `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

// Pins on every clone command: no hooks, fsmonitor, gpg signing or submodule push. Filters need no pin here because the
// fresh clone carries no config that names one, so a filter driver is never defined.
const CLONE_PINS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "push.recurseSubmodules=no"];

/** A git command in the publish clone; `network` for the fetch and push to github.com, which git's own low-speed limit bounds. */
export type CloneGit = (args: string[], network?: boolean) => Promise<string>;

/** The real path of `dir`, resolved as far as it exists, so a symlink or `..` in it cannot hide what it points at. */
const realDir = (dir: string) => realpath(resolve(dir)).catch(() => resolve(dir));

/** Whether `child` is `parent` or inside it, comparing real paths and, where a file system ignores case, case-insensitively. */
function under(child: string, parent: string): boolean {
  const rel = (a: string, b: string) => relative(a, b);
  const inside = (p: string, c: string) => {
    const r = rel(p, c);
    return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r));
  };
  return inside(parent, child) || inside(parent.toLowerCase(), child.toLowerCase());
}

/**
 * The absolute real path of `name` for a job that holds the token: from an absolute PATH entry, resolved through every
 * link, and refused when it lies in a folder a repository or this run controls (the current folder, GITHUB_WORKSPACE, the
 * temp root), compared by real path so a symlink, `..` or case difference cannot slip past. So a `git` or `gh` the
 * repository ships or the checkout folder holds is never run by a bare name or relative lookup. Returns undefined only
 * when `required` is false and the program is simply not on PATH.
 */
export async function trustedProgram(name: string, required = true): Promise<string | undefined> {
  const found = await onPath(name);
  if (!found) {
    if (required) throw new Refusal(`${name} was not found in an absolute PATH entry; --publish runs ${name} by its absolute path`);
    return undefined;
  }
  const real = await realpath(found).catch(() => resolve(found));
  const owned = await Promise.all([process.cwd(), process.env.GITHUB_WORKSPACE?.trim(), tmpdir()].filter((p): p is string => !!p).map(realDir));
  const bad = owned.find((o) => under(real, o));
  if (bad) throw new Refusal(`${name} resolves to ${real}, under ${bad}, a folder this job controls; refusing to run it`);
  return real;
}


/**
 * Runs `body` against a fresh, shallow clone of `sha` fetched from `url` (github.com) with the already-resolved absolute
 * `gitBin`, reading no config, replace object, hook, filter or object store from the machine or any repository: the env is
 * process.env minus the credential variables and every GIT_* variable (never through childEnv/repoLocalVars, which would
 * run git by a bare name in this folder), plus GIT_CONFIG_NOSYSTEM, an empty global config, HOME and XDG_CONFIG_HOME in an
 * empty folder, and GIT_NO_REPLACE_OBJECTS. The token reaches git only as an http header scoped to github.com. The folder
 * is removed afterwards.
 */
export async function withCleanClone<T>(gitBin: string, url: string, sha: string, token: string, body: (run: CloneGit, dir: string) => Promise<T>, beforeFetch?: (run: CloneGit) => Promise<void>): Promise<T> {
  const tmp = await mkdtemp(join(tmpdir(), "darnit-publish-"));
  const [home, dir, global] = [join(tmp, "home"), join(tmp, "repo"), join(tmp, "global.config")];
  await mkdir(home);
  await mkdir(dir);
  await writeFile(global, "");
  // An allowlist, not process.env minus a denylist: a credential, a GIT_* (trace, config, replace), SSH_ASKPASS or any
  // other inherited variable is never carried in; only darnit's own hardening, set here, reaches git.
  const env = cleanEnv({
    HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: global, GIT_NO_REPLACE_OBJECTS: "1",
    GIT_LITERAL_PATHSPECS: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${GITHUB}.extraheader`, GIT_CONFIG_VALUE_0: authHeader(token),
  });
  const stall = 60;
  // cwd is the temp parent, never the work tree, and the repo is named with -C: nothing the commit ships is on the lookup path.
  const run: CloneGit = async (args, network = false) => {
    const netEnv = network ? { GIT_HTTP_LOW_SPEED_LIMIT: "1", GIT_HTTP_LOW_SPEED_TIME: String(stall) } : {};
    try {
      const { stdout } = await exec(gitBin, ["-C", dir, ...CLONE_PINS, ...args], { cwd: tmp, env: { ...env, ...netEnv }, maxBuffer: 64 * 1024 * 1024, timeout: network ? stall * 4 * 1000 : 0 });
      return stdout;
    } catch (err) {
      const { killed, stderr } = err as { killed?: boolean; stderr?: string };
      if (network && (killed || stderr?.includes("Operation too slow"))) throw new Error(`git ${args[0] ?? ""} to origin timed out`, { cause: err });
      throw err;
    }
  };
  try {
    await run(["init", "-q"]);
    if (beforeFetch) await beforeFetch(run);
    await run(["fetch", "-q", "--depth=1", "--no-tags", url, sha], true);
    await run(["checkout", "-q", "--detach", "FETCH_HEAD"]);
    return await body(run, dir);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Diff between two dirs under cwd, no repo needed. git exits 1 when they differ, which is not an error here. */
export async function diffDirs(cwd: string, before: string, after: string): Promise<string> {
  try {
    return await git(cwd, ["--no-pager", "diff", "--no-index", "--color=never", before, after]);
  } catch (err) {
    const { code, stdout } = err as { code?: number; stdout?: string };
    if (code === 1 && stdout !== undefined) return stdout;
    throw err;
  }
}
