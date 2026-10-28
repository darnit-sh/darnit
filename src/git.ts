import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CREDENTIALS } from "./tests.js";

const exec = promisify(execFile);

// The repo's own commands can write .git/config and .git/hooks, so git runs none of their hooks or
// fsmonitor, never sees darnit's credentials, and takes file names literally, never as patterns.
const UNTRUSTED_REPO = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/**
 * `stall` bounds a call that reaches the remote: git itself ends an HTTPS transfer that sends nothing
 * for that many seconds, and the process is stopped after four times as long for any other transport.
 */
export async function git(root: string, args: string[], stall?: number): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_LITERAL_PATHSPECS: "1" };
  for (const k of CREDENTIALS) delete env[k];
  const net = stall ? ["-c", "http.lowSpeedLimit=1", "-c", `http.lowSpeedTime=${stall}`] : [];
  try {
    const { stdout } = await exec("git", [...UNTRUSTED_REPO, ...net, ...args], {
      cwd: root,
      env,
      maxBuffer: 64 * 1024 * 1024,
      ...(stall ? { timeout: stall * 4 * 1000 } : {}),
    });
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

export const remoteBranchExists = async (root: string, name: string) =>
  (await git(root, ["ls-remote", "--heads", "origin", name], 30)).trim() !== "";

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

export const push = (root: string, branch: string) => git(root, ["push", "-q", "-u", "origin", branch], 60);

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
