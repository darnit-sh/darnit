import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// darnit's GitHub credentials open the pull request; the repository's own commands never get them.
export const CREDENTIALS = ["GITHUB_TOKEN", "GH_TOKEN"];

// The repo's own commands can write .git/config and .git/hooks, so git runs none of their hooks or
// fsmonitor, never sees darnit's credentials, and takes file names literally, never as patterns.
const UNTRUSTED_REPO = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

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
function command(args: string[]): { name: string; remote: boolean } {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i += VALUED.has(args[i]!) ? 2 : 1;
  const [name = "", ...rest] = args.slice(i);
  // An alias set on the command line can stand for any command, so it counts as one that reaches origin.
  const opts = args.slice(0, i);
  if (opts.some((a, j) => /^--config-env=alias\./i.test(a) || (["-c", "--config-env"].includes(a) && /^alias\./i.test(opts[j + 1] ?? "")))) return { name, remote: true };
  if (name !== "remote") return { name, remote: REMOTE.has(name) };
  const sub = rest.find((a) => !a.startsWith("-"));
  return { name, remote: sub !== undefined && (!LOCAL_REMOTE.has(sub) || (sub === "add" && rest.some((a) => a === "-f" || a === "--fetch"))) };
}

/**
 * `stall` marks a call to origin and bounds it. Git itself ends an HTTP or HTTPS transfer that moves
 * less than a byte a second for that many seconds; the environment beats any `http.<url>.lowSpeed*`
 * config. Any other transport is stopped after four times as long, which can leave its ssh child
 * running. In GitHub Actions the call also gets the token for `site` (see originAuth).
 */
export async function git(root: string, args: string[], stall?: number, site = GITHUB): Promise<string> {
  const { name, remote } = command(args);
  if (!stall && remote) throw new Error(`git ${name} reaches origin, so it needs a stall limit`);
  const env: NodeJS.ProcessEnv = { ...(await childEnv()), GIT_LITERAL_PATHSPECS: "1" };
  let timeout = 0;
  if (stall) {
    Object.assign(env, originAuth(site), { GIT_HTTP_LOW_SPEED_LIMIT: "1", GIT_HTTP_LOW_SPEED_TIME: String(stall) });
    // A process timeout would cut a slow but healthy HTTPS push and leave its helper pushing.
    const urls = (await git(root, ["remote", "get-url", "--all", ...(name === "push" ? ["--push"] : []), "origin"])).split("\n").filter(Boolean);
    if (!urls.every((u) => /^https?:\/\//i.test(u))) timeout = stall * 4 * 1000;
  }
  try {
    const { stdout } = await exec("git", [...UNTRUSTED_REPO, ...args], { cwd: root, env, maxBuffer: 64 * 1024 * 1024, timeout });
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
function originAuth(site: string): NodeJS.ProcessEnv {
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (!token || process.env.GITHUB_ACTIONS !== "true") return {};
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  // git() drops any GIT_CONFIG_COUNT it inherits, so these are the only entries.
  return {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `http.${site}.extraheader`,
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: `http.${site}.extraheader`,
    GIT_CONFIG_VALUE_1: header,
  };
}

export const push = (root: string, branch: string, site = GITHUB) => git(root, ["push", "-q", "-u", "origin", branch], 60, site);

export const diff = (root: string, files: readonly string[], color: boolean) =>
  git(root, ["--no-pager", "diff", color ? "--color=always" : "--color=never", "--", ...files]);

export const head = async (root: string) => (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();

// Settings the repository can set that change a diff's bytes; pinned so two checkouts produce the same patch.
const PINNED_DIFF = ["core.quotePath=false", "diff.noprefix=false", "diff.mnemonicPrefix=false", "diff.suppressBlankEmpty=false", "diff.orderFile=/dev/null"];

/** `files` (relative to `root`) against HEAD as `git diff --binary` prints them, with paths relative to `root`. */
export const patch = (root: string, files: readonly string[]) =>
  git(root, [
    ...PINNED_DIFF.flatMap((c) => ["-c", c]),
    "--no-pager", "diff", "--binary", "--full-index", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--relative",
    "--src-prefix=a/", "--dst-prefix=b/", "--unified=3", "--inter-hunk-context=0", "--diff-algorithm=myers", "--indent-heuristic",
    "HEAD", "--", ...files,
  ]);

/** Diff between two dirs under cwd, no repo needed. git exits 1 when they differ, which is not an error here. */
export async function diffDirs(cwd: string, before: string, after: string, color: boolean): Promise<string> {
  try {
    return await git(cwd, ["--no-pager", "diff", "--no-index", color ? "--color=always" : "--color=never", before, after]);
  } catch (err) {
    const { code, stdout } = err as { code?: number; stdout?: string };
    if (code === 1 && stdout !== undefined) return stdout;
    throw err;
  }
}
