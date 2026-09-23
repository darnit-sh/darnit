import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const API = "https://api.github.com";

export type Repo = { owner: string; repo: string };

export async function githubToken(): Promise<string | undefined> {
  const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (env) return env;
  try {
    return (await exec("gh", ["auth", "token"])).stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function parseRemote(url: string): Repo | undefined {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  return m ? { owner: m[1]!, repo: m[2]! } : undefined;
}

export function parseSlug(slug: string): Repo | undefined {
  const m = /^([^/]+)\/([^/]+)$/.exec(slug);
  return m ? { owner: m[1]!, repo: m[2]! } : undefined;
}

async function api<T>(token: string, method: string, path: string, body?: object): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "darnit",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

export async function defaultBranch(token: string, { owner, repo }: Repo): Promise<string> {
  return (await api<{ default_branch: string }>(token, "GET", `/repos/${owner}/${repo}`)).default_branch;
}

export async function findOpenPr(token: string, { owner, repo }: Repo, head: string): Promise<string | undefined> {
  const prs = await api<{ html_url: string }[]>(token, "GET", `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`);
  return prs[0]?.html_url;
}

export async function createPr(
  token: string,
  { owner, repo }: Repo,
  pr: { title: string; head: string; base: string; body: string },
): Promise<string> {
  return (await api<{ html_url: string }>(token, "POST", `/repos/${owner}/${repo}/pulls`, pr)).html_url;
}
