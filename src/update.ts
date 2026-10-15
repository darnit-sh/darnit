import { request } from "node:https";
import { pinned } from "./init.js";
import { atLeast } from "./versions.js";

const REGISTRY = "https://registry.npmjs.org/-/package/darnit/dist-tags";
const RELEASE = /^\d+\.\d+\.\d+$/;
const MAX_BYTES = 4096;
const BUDGET_MS = 1500;

type Get = (url: string, signal: AbortSignal) => Promise<{ status: number; body: AsyncIterable<Uint8Array> | null }>;
type Options = { env: NodeJS.ProcessEnv; json?: boolean | undefined; get?: Get };

/** node:https rather than fetch: fetch leaves a stalled connection open after the abort, holding the run for seconds. */
export const get: Get = (url, signal) =>
  new Promise((resolve, reject) => {
    request(url, { signal, headers: { accept: "application/json" } }, (res) => resolve({ status: res.statusCode ?? 0, body: res }))
      .on("error", reject)
      .end();
  });

/** The newest release on npm, or undefined for anything but a small JSON body naming a plain x.y.z. Registry text is untrusted. */
async function latest(ask: Get, signal: AbortSignal): Promise<string | undefined> {
  const res = await ask(REGISTRY, signal);
  if (res.status !== 200 || !res.body) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > MAX_BYTES) return undefined;
    chunks.push(chunk);
  }
  const tag = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { latest?: unknown } | null)?.latest;
  return typeof tag === "string" && RELEASE.test(tag) ? tag : undefined;
}

/**
 * One line when npm has a release on a newer line than the one `init` pins, else undefined. Starts the request at
 * once and settles within 1.5 seconds of the call, never rejects, and never asks with --json or an off switch set.
 */
export async function updateNotice(current: string, { env, json, get: ask = get }: Options): Promise<string | undefined> {
  if (json || env.DARNIT_NO_UPDATE_CHECK || env.NO_UPDATE_NOTIFIER || !RELEASE.test(current)) return undefined;
  const signal = AbortSignal.timeout(BUDGET_MS);
  const timeout = new Promise<undefined>((resolve) => signal.addEventListener("abort", () => resolve(undefined)));
  const next = await Promise.race([latest(ask, signal), timeout]).catch(() => undefined);
  if (!next || pinned(next) === pinned(current) || !atLeast(next, current)) return undefined;
  const line = `darnit ${next} is out (you have ${current}): see darnit.sh/changelog and change darnit@${pinned(current)} to darnit@${pinned(next)} in .github/workflows/darnit.yml`;
  return env.GITHUB_ACTIONS === "true" ? `::notice::${line}` : line;
}
