import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CREDENTIALS } from "./tests.js";

const exec = promisify(execFile);

// The repo's own commands can write .git/config and .git/hooks, so git runs none of their hooks or
// fsmonitor, never sees darnit's credentials, and takes file names literally, never as patterns.
const UNTRUSTED_REPO = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

const GITHUB = "https://github.com/";
// git commands that reach origin. git() refuses them without `stall`, which also brings the token.
const REMOTE = new Set(["push", "fetch", "pull", "ls-remote", "clone", "archive", "submodule"]);

/**
 * `stall` marks a call to origin and bounds it. Git itself ends an HTTP or HTTPS transfer that moves
 * less than a byte a second for that many seconds; the environment beats any `http.<url>.lowSpeed*`
 * config. Any other transport is stopped after four times as long, which can leave its ssh child
 * running. In GitHub Actions the call also gets the token for `site` (see originAuth).
 */
export async function git(root: string, args: string[], stall?: number, site = GITHUB): Promise<string> {
  const command = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c");
  if (!stall && REMOTE.has(command!)) throw new Error(`git ${command} reaches origin, so it needs a stall limit`);
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_LITERAL_PATHSPECS: "1" };
  for (const k of CREDENTIALS) delete env[k];
  let timeout = 0;
  if (stall) {
    Object.assign(env, originAuth(site), { GIT_HTTP_LOW_SPEED_LIMIT: "1", GIT_HTTP_LOW_SPEED_TIME: String(stall) });
    // A process timeout would cut a slow but healthy HTTPS push and leave its helper pushing.
    const urls = (await git(root, ["remote", "get-url", "--all", ...(args[0] === "push" ? ["--push"] : []), "origin"])).split("\n").filter(Boolean);
    if (!urls.every((u) => /^https?:\/\//i.test(u))) timeout = stall * 4 * 1000;
  }
  try {
    const { stdout } = await exec("git", [...UNTRUSTED_REPO, ...args], { cwd: root, env, maxBuffer: 64 * 1024 * 1024, timeout });
    return stdout;
  } catch (err) {
    const { killed, stderr } = err as { killed?: boolean; stderr?: string };
    if (stall && (killed || stderr?.includes("Operation too slow"))) {
      throw new Error(`git ${args[0]} timed out after ${killed ? stall * 4 : stall} seconds`, { cause: err });
    }
    throw err;
  }
}

export const isRepo = (root: string) =>
  git(root, ["rev-parse", "--is-inside-work-tree"]).then(
    () => true,
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

export const dirtyAmong = async (root: string, files: readonly string[]) =>
  (await git(root, ["status", "--porcelain", "--", ...files])).trim() !== "";

/** Tracked files under `root` with changes, staged or not, relative to `root`. */
export const modified = async (root: string) => (await git(root, ["diff", "--name-only", "-z", "--relative", "HEAD"])).split("\0").filter(Boolean);

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
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token || process.env.GITHUB_ACTIONS !== "true") return {};
  const n = Number(process.env.GIT_CONFIG_COUNT) || 0;
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  return {
    GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: `http.${site}.extraheader`,
    [`GIT_CONFIG_VALUE_${n}`]: "",
    [`GIT_CONFIG_KEY_${n + 1}`]: `http.${site}.extraheader`,
    [`GIT_CONFIG_VALUE_${n + 1}`]: header,
  };
}

export const push = (root: string, branch: string, site = GITHUB) => git(root, ["push", "-q", "-u", "origin", branch], 60, site);

export const diff = (root: string, files: readonly string[], color: boolean) =>
  git(root, ["--no-pager", "diff", color ? "--color=always" : "--color=never", "--", ...files]);

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
