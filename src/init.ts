import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { stringify } from "yaml";
import { detectApis, readText, skippedNote, tooLargeNote, VENDORS, type Skipped } from "./detect.js";
import { isRepo, uncommitted, uncommittedReasons } from "./git.js";

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
      - run: cd "\${RUNNER_TEMP:?}" && npx darnit@${pinned(version)} check "\${GITHUB_WORKSPACE:?}"
`;

const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = constants;

/**
 * Refuses `path` when its folder, links followed, is not inside root: a cloned repository can plant links.
 * Returns that folder, or its nearest existing parent, relative to root.
 */
async function refuseOutside(root: string, path: string, rel: string): Promise<string> {
  let dir = dirname(path);
  for (;;) {
    try {
      dir = await realpath(dir);
      break;
    } catch (err) {
      const { code } = err as NodeJS.ErrnoException;
      if (code === "ENOTDIR") throw new Error(`${rel} cannot be written: part of its path is a file, not a folder`, { cause: err });
      if (code !== "ENOENT" || dir === root) throw err;
      if (await lstat(dir).then(() => true, () => false)) throw new Error(`${rel} goes through a broken symbolic link; darnit only writes files inside the repository`, { cause: err });
      dir = dirname(dir);
    }
  }
  const inside = relative(await realpath(root), dir);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error(`${rel} is outside the repository; darnit only writes files inside it`);
  return inside;
}

const unchanged = (rel: string) => `${rel} exists, left unchanged (--force to rewrite)`;

/** Only darnit names files like this; one is left behind if a run is killed between writing and renaming it. */
const TEMP = /^\.darnit-[0-9a-f-]{36}\.tmp$/;

/**
 * Checks root/rel before anything is written. Returns why it is left alone, or the file a rewrite replaces and
 * its path with folder links resolved, the name git has it under.
 */
async function inspect(root: string, rel: string, text: string, force: boolean): Promise<{ skip?: string; old?: Stats; real?: string }> {
  const folder = await refuseOutside(root, join(root, rel), rel);
  const old = await lstat(join(root, rel)).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw err;
  });
  if (!old) return {};
  if (old.isSymbolicLink()) {
    if (force) throw new Error(`${rel} is a symbolic link; darnit only writes files inside the repository`);
    return { skip: `${rel} is a symbolic link, left unchanged` };
  }
  if (!force) return { skip: unchanged(rel) };
  if (!old.isFile()) throw new Error(`${rel} is not a file; darnit only rewrites files`);
  if ((await readText(join(root, rel))) === text) return { skip: `${rel} is up to date, left unchanged` };
  return { old, real: join(folder, basename(rel)) };
}

/** Refuses to rewrite files git could not put back, since the rewrite would lose their only copy. */
async function refuseUncommitted(root: string, files: { rel: string; real: string }[]): Promise<void> {
  if (files.length === 0) return;
  const rels = files.map((f) => f.rel);
  if (!(await isRepo(root))) {
    const it = rels.length > 1 ? "them" : "it";
    throw new Error(`not a checked-out git repository, so git could not put back ${rels.join(", ")} if --force rewrote ${it}; move ${it} aside first, then run init again`);
  }
  const unsafe = await uncommitted(root, files.map((f) => f.real));
  const why = uncommittedReasons(unsafe.map((u) => ({ ...u, file: files.find((f) => f.real === u.file)!.rel })), "init --force would rewrite");
  if (why.length > 0) throw new Error(why.join("; "));
}

/** `darnit init`: detect APIs, write darnit.yml and the scheduled workflow. Returns log lines. */
export async function init(root: string, { force = false } = {}): Promise<string[]> {
  const tooLarge: string[] = [];
  const skipped: Skipped[] = [];
  const found = await detectApis(root, tooLarge, skipped);
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
  const plans = await Promise.all(files.map(([rel, text]) => inspect(root, rel, text, force)));
  await refuseUncommitted(root, files.flatMap(([rel], i) => (plans[i]?.real ? [{ rel, real: plans[i].real }] : [])));
  // Every file is written before any is renamed into place, so a failed write changes nothing. A rewrite goes to a new
  // file, so the old one, and any hard link to it, is never written.
  const made: string[] = [];
  const renames: [string, string][] = [];
  const log: string[] = [];
  let current = "";
  try {
    for (const [i, [rel, text]] of files.entries()) {
      const { skip, old } = plans[i] ?? {};
      if (skip) {
        log.push(skip);
        continue;
      }
      current = rel;
      const path = join(root, rel);
      await mkdir(dirname(path), { recursive: true });
      for (const name of await readdir(dirname(path))) if (TEMP.test(name)) await rm(join(dirname(path), name)).catch(() => {});
      const target = old ? join(dirname(path), `.darnit-${randomUUID()}.tmp`) : path;
      const file = await open(target, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW).catch((err: NodeJS.ErrnoException) => {
        if (!old && err.code === "EEXIST") return undefined;
        throw err;
      });
      if (!file) {
        log.push(unchanged(rel));
        continue;
      }
      made.push(target);
      try {
        await file.writeFile(text);
        if (old) await file.chmod(old.mode & 0o777);
      } finally {
        await file.close();
      }
      if (old) renames.push([target, path]);
      log.push(`${old ? "Rewrote" : "Wrote"} ${rel}`);
    }
  } catch (err) {
    await Promise.all(made.map((p) => rm(p, { force: true })));
    const { code } = err as NodeJS.ErrnoException;
    throw new Error(`could not write ${current} (${code === "EACCES" || code === "EPERM" ? "permission denied" : (code ?? String(err))}); no file was changed`, { cause: err });
  }
  for (const [from, to] of renames) await rename(from, to);
  return [summary, ...tooLargeNote(tooLarge), ...skippedNote(skipped), ...log];
}
