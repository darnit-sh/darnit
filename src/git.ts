import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export const isRepo = (root: string) =>
  git(root, ["rev-parse", "--is-inside-work-tree"]).then(
    () => true,
    () => false,
  );

export const isClean = async (root: string) => (await git(root, ["status", "--porcelain"])).trim() === "";

export const currentBranch = async (root: string) => (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();

export const localBranchExists = (root: string, name: string) =>
  git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).then(
    () => true,
    () => false,
  );

export const remoteBranchExists = async (root: string, name: string) =>
  (await git(root, ["ls-remote", "--heads", "origin", name])).trim() !== "";

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

export const deleteBranch = (root: string, name: string) => git(root, ["branch", "-q", "-D", name]);

export const add = (root: string, files: readonly string[]) => git(root, ["add", "--", ...files]);

/** Commits as the configured user, or as darnit when the machine has no identity (CI runners). */
export async function commit(root: string, subject: string, body: string): Promise<void> {
  const email = await git(root, ["config", "user.email"]).catch(() => "");
  const identity = email.trim() ? [] : ["-c", "user.name=darnit", "-c", "user.email=darnit@users.noreply.github.com"];
  await git(root, [...identity, "commit", "-q", "-m", subject, "-m", body]);
}

export const push = (root: string, branch: string) => git(root, ["push", "-q", "-u", "origin", branch]);

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
