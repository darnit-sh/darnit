import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { cleanEnv, onPath } from "./detect.js";
import { Refusal } from "./refusal.js";

const exec = promisify(execFile);
const API = "https://api.github.com";
// GitHub ends any request it takes over 10 seconds to handle, so a call still unanswered at 30 is stalled.
const TIMEOUT_MS = 30_000;

export type Repo = { owner: string; repo: string };

// GitHub tokens are printable ASCII. fetch quotes a header value it rejects in its error, so a token
// with a line break inside would be printed.
const checked = (token: string) => {
  if (/[^\x21-\x7e]/.test(token))
    throw new Refusal(
      "the GitHub token holds a character other than printable ASCII (a space, control or zero-width character, or a letter outside ASCII); set it again without one",
    );
  return token || undefined;
};

/** GITHUB_TOKEN, else GH_TOKEN, trimmed. */
export const envToken = () => checked(process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || "");

/**
 * The token from the environment, else from `gh auth token`. gh is resolved to an absolute path and run from a neutral
 * folder, so a scanned repository cannot ship the gh that runs here. `resolveGh` returns that path (undefined when gh is
 * not on PATH); --publish passes a resolver that also refuses a gh under a folder the job controls.
 */
export async function githubToken(
  resolveGh: () => Promise<string | undefined> = () => onPath("gh"),
): Promise<string | undefined> {
  const env = envToken();
  if (env) return env;
  const gh = await resolveGh();
  if (!gh) return undefined;
  let out: string;
  try {
    // The allowlist environment, plus the folders gh reads its login from; no credential or other inherited variable reaches it.
    const extra: NodeJS.ProcessEnv = {};
    for (const k of ["HOME", "XDG_CONFIG_HOME", "GH_CONFIG_DIR"])
      if (process.env[k] !== undefined) extra[k] = process.env[k];
    out = (await exec(gh, ["auth", "token"], { cwd: tmpdir(), env: cleanEnv(extra) })).stdout;
  } catch {
    return undefined;
  }
  return checked(out.trim());
}

// Only characters GitHub allows in names, so a name can never change the API path.
const NAME = String.raw`([A-Za-z0-9_-]+)/([A-Za-z0-9_.-]+)`;
const REMOTE = new RegExp(
  String.raw`^(?:(?:https|ssh)://(?:[^@/?#\\]+@)?github\.com/|(?:[^@/:]+@)?github\.com:)${NAME}/?$`,
  "i",
);
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
  // Should fetch or a server quote the token anyway, it never reaches darnit's message.
  const hide = (text: string) => (token ? text.replaceAll(token, "***") : text);
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
    if (signal.aborted)
      throw new Error(`GitHub ${method} ${path} timed out after ${TIMEOUT_MS / 1000} seconds`, { cause: err });
    const { message, cause } = err as Error;
    // No cause: fetch's error can hold the token, and printing an error prints its cause.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(
      hide(`GitHub ${method} ${path} failed: ${message}${cause instanceof Error ? ` (${cause.message})` : ""}`),
    );
  }
  if (!res.ok) throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${hide(text).slice(0, 300)}`);
  return JSON.parse(text) as T;
}

export async function defaultBranch(token: string, repo: Repo): Promise<string> {
  return (await api<{ default_branch: string }>(token, "GET", repoPath(repo))).default_branch;
}

export async function findOpenPr(token: string, repo: Repo, head: string): Promise<string | undefined> {
  const prs = await api<{ html_url: string }[]>(
    token,
    "GET",
    `${repoPath(repo)}/pulls?state=open&head=${encodeURIComponent(`${repo.owner}:${head}`)}`,
  );
  return prs[0]?.html_url;
}

export async function createPr(
  token: string,
  repo: Repo,
  pr: { title: string; head: string; base: string; body: string },
): Promise<string> {
  return (await api<{ html_url: string }>(token, "POST", `${repoPath(repo)}/pulls`, pr)).html_url;
}
