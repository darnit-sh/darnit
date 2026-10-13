import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { stringify } from "yaml";
import { detectApis, tooLargeNote, VENDORS } from "./detect.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/** The version a written workflow runs: the minor line before 1.0, the major line from 1.0, or the exact version for a prerelease, which no range matches. */
export function pinned(v: string): string {
  if (v.includes("-")) return v;
  const [major, minor] = v.split(".");
  return major === "0" ? `0.${minor}` : (major ?? v);
}

const WORKFLOW = `name: darnit

on:
  schedule:
    - cron: "17 6 * * *"
  workflow_dispatch: {}

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          package-manager-cache: false
      - run: npx darnit@${pinned(version)} check
`;

const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = constants;

/** Refuses `path` when its folder, links followed, is not inside root: a cloned repository can plant links. */
async function refuseOutside(root: string, path: string, rel: string): Promise<void> {
  let dir = dirname(path);
  for (;;) {
    try {
      dir = await realpath(dir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || dir === root) throw err;
      if (await lstat(dir).then(() => true, () => false)) throw new Error(`${rel} goes through a broken symbolic link; darnit only writes files inside the repository`, { cause: err });
      dir = dirname(dir);
    }
  }
  const inside = relative(await realpath(root), dir);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error(`${rel} is outside the repository; darnit only writes files inside it`);
}

/** Checks root/rel before anything is written. Returns why it is left alone, or undefined to write it. */
async function refuseOrSkip(root: string, rel: string, force: boolean): Promise<string | undefined> {
  await refuseOutside(root, join(root, rel), rel);
  const st = await lstat(join(root, rel)).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw err;
  });
  if (!st) return undefined;
  if (st.isSymbolicLink()) {
    if (force) throw new Error(`${rel} is a symbolic link; darnit only writes files inside the repository`);
    return `${rel} is a symbolic link, left unchanged`;
  }
  if (!force) return `${rel} exists, left unchanged (--force to rewrite)`;
  if (!st.isFile()) throw new Error(`${rel} is not a file; darnit only rewrites files`);
  return undefined;
}

/** Writes a new file. A rewrite goes to a new file renamed into place, so the old one, and any hard link to it, is never written. */
async function place(path: string, text: string, rewrite: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const target = rewrite ? `${path}.${randomUUID()}.tmp` : path;
  try {
    const file = await open(target, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW);
    await file.writeFile(text).finally(() => file.close());
    if (rewrite) await rename(target, path);
  } catch (err) {
    if (rewrite) await rm(target, { force: true });
    throw err;
  }
}

/** `darnit init`: detect APIs, write darnit.yml and the scheduled workflow. Returns log lines. */
export async function init(root: string, { force = false } = {}): Promise<string[]> {
  const tooLarge: string[] = [];
  const found = await detectApis(root, tooLarge);
  const summary =
    found.length === 0
      ? "Scanned repo: no known APIs found (the scheduled check still runs)"
      : `Scanned repo: found ${found.map((f) => `${f.vendor} (${f.evidence[0]}${VENDORS[f.vendor].tier === "recognized" ? "; recognized only" : ""})`).join(", ")}`;

  const config = {
    version: 1,
    apis: Object.fromEntries(found.map((f) => [f.vendor, { tier: VENDORS[f.vendor].tier, evidence: f.evidence }])),
  };
  const yml = `# darnit configuration (https://darnit.sh)\n# tier: supported = rule packs exist; recognized = named only, no change records yet; request support on GitHub\n${stringify(config)}`;

  const files = [
    ["darnit.yml", yml],
    [".github/workflows/darnit.yml", WORKFLOW],
  ] as const;
  const skips = await Promise.all(files.map(([rel]) => refuseOrSkip(root, rel, force)));
  const log = [];
  for (const [i, [rel, text]] of files.entries()) {
    if (!skips[i]) await place(join(root, rel), text, force);
    log.push(skips[i] ?? `${force ? "Rewrote" : "Wrote"} ${rel}`);
  }
  return [summary, ...tooLargeNote(tooLarge), ...log];
}
