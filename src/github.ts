import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const API = "https://api.github.com";
// GitHub ends any request it takes over 10 seconds to handle, so a call still unanswered at 30 is stalled.
const TIMEOUT_MS = 30_000;

export type Repo = { owner: string; repo: string };

export async function githubToken(): Promise<string | undefined> {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env;
  try {
    return (await exec("gh", ["auth", "token"])).stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

// Only characters GitHub allows in names, so a name can never change the API path.
const NAME = String.raw`([A-Za-z0-9_-]+)/([A-Za-z0-9_.-]+)`;
const REMOTE = new RegExp(String.raw`^(?:(?:https|ssh)://(?:[^@/?#\\]+@)?github\.com/|(?:[^@/:]+@)?github\.com:)${NAME}/?$`, "i");
const SLUG = new RegExp(`^${NAME}$`);

function toRepo(m: RegExpExecArray | null): Repo | undefined {
  if (!m) return undefined;
  const repo = m[2]!.replace(/\.git$/, "");
  return repo === "" || repo === "." || repo === ".." ? undefined : { owner: m[1]!, repo };
}

export function parseRemote(url: string): Repo | undefined {
  return toRepo(REMOTE.exec(url));
}

export function parseSlug(slug: string): Repo | undefined {
  return toRepo(SLUG.exec(slug));
}

const repoPath = ({ owner, repo }: Repo) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

async function api<T>(token: string, method: string, path: string, body?: object): Promise<T> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "darnit",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    text = await res.text();
  } catch (err) {
    if (signal.aborted) throw new Error(`GitHub ${method} ${path} timed out after ${TIMEOUT_MS / 1000} seconds`, { cause: err });
    const { message, cause } = err as Error;
    throw new Error(`GitHub ${method} ${path} failed: ${message}${cause instanceof Error ? ` (${cause.message})` : ""}`, { cause: err });
  }
  if (!res.ok) throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

export async function defaultBranch(token: string, repo: Repo): Promise<string> {
  return (await api<{ default_branch: string }>(token, "GET", repoPath(repo))).default_branch;
}

export async function findOpenPr(token: string, repo: Repo, head: string): Promise<string | undefined> {
  const prs = await api<{ html_url: string }[]>(token, "GET", `${repoPath(repo)}/pulls?state=open&head=${encodeURIComponent(`${repo.owner}:${head}`)}`);
  return prs[0]?.html_url;
}

export async function createPr(
  token: string,
  repo: Repo,
  pr: { title: string; head: string; base: string; body: string },
): Promise<string> {
  return (await api<{ html_url: string }>(token, "POST", `${repoPath(repo)}/pulls`, pr)).html_url;
}
