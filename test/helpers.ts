import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { TestRunner } from "vitest";

// Each run holds its syntax trees until they are collected, so a repeat collects them first.
setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;

/**
 * Milliseconds of CPU time `f` takes, which shared runners and parallel test files disturb less than wall time.
 * With `runs`, the least of up to that many runs, as noise only adds time. With a `budget`, it stops at the
 * first run under it, so a healthy check runs once, or once a run is over 1.5 times it, so a regression fails quickly.
 */
export async function cpuTime(f: () => unknown, runs = 1, budget?: number): Promise<number> {
  // Coverage slows the code it times, so CI runs these tests in a pass of their own, picked by the tag.
  const test = TestRunner.getCurrentTest();
  if (!test?.tags?.includes("cpu-time"))
    throw new Error(`tag "${test?.name ?? "this test"}" cpu-time, as it measures CPU time`);
  let least = Infinity;
  for (let i = 0; i < runs; i++) {
    if (i > 0) {
      collect();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const start = process.cpuUsage();
    await f();
    const { user, system } = process.cpuUsage(start);
    const ms = (user + system) / 1000;
    least = Math.min(least, ms);
    if (budget !== undefined && (ms < budget || ms > 1.5 * budget)) break;
  }
  return least;
}

/**
 * The CPU time `f` takes over that of `baseline`, each the least of `runs`. A busy machine slows both, so the ratio
 * holds where a fixed number of milliseconds does not. It stops early as `cpuTime` does around `bound` times the
 * baseline, and measures the baseline again when `f` lands over that, in case the machine got busier in between.
 */
export async function slowdown(f: () => unknown, baseline: () => unknown, bound: number, runs = 3): Promise<number> {
  let base = await cpuTime(baseline, runs);
  const time = await cpuTime(f, runs, bound * base);
  if (time >= bound * base) base = Math.max(base, await cpuTime(baseline, runs));
  return time / base;
}

/**
 * The problem matchers `actions/setup-node@v7` registers on every run, by owner: the patterns in its .github/tsc.json,
 * eslint-stylish.json and eslint-compact.json at 949feb2413d6458794dcd2491c4babbbce0c15c1 (v7.1.0), the commit v7 names.
 * Two match the same lines as there but read each run of spaces once: tsc's ends in `\s*:\s*(.*)$` there, and the
 * second eslint-stylish pattern there is `^\s+(\d+):(\d+)\s+(error|warning|info)\s+(.*)\s\s+(.*)$`, which a line
 * matches when what follows the severity starts with a space and holds two spaces in a row, and every line break after
 * its first other character sits in one run of two or more spaces, with no line break after that run.
 */
export const SETUP_NODE_MATCHERS: Record<string, RegExp[]> = {
  tsc: [/^([^\s].*)[(:](\d+)[,:](\d+)(?:\):\s+|\s+-\s+)(error|warning|info)\s+TS(\d+)\s*:\s*((?:\S.*)?)$/],
  "eslint-stylish": [
    /^\s*([^\s].*)$/,
    /^\s+(\d+):(\d+)\s+(error|warning|info)\s(?:(?=\s*(?:\S.*)?$)[^]*?\s\s|\s*\S(?=(.*))\4(?:(?<=\s)\s+|\s\s+)(?:\S.*)?$)/,
  ],
  "eslint-compact": [/^(.+):\sline\s(\d+),\scol\s(\d+),\s([Ee]rror|[Ww]arning|[Ii]nfo)\s-\s(.+)\s\((.+)\)$/],
};

/**
 * The lines of `output` that the runner's matchers `owners` turn into annotations, as `owner: line`. Like the runner,
 * it drops color codes, ignores stop-commands, and repeats the last of two patterns while lines match it.
 */
export function annotations(output: string, owners: string[]): string[] {
  const found: string[] = [];
  const started = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    // eslint-disable-next-line no-control-regex
    const text = line.replace(/\u001b\[[0-9;]*m/g, "");
    for (const owner of owners) {
      const [first, last] = SETUP_NODE_MATCHERS[owner]!;
      if (!last ? first!.test(text) : started.has(owner) && last.test(text)) found.push(`${owner}: ${line}`);
      else if (last && first!.test(text)) started.add(owner);
      else started.delete(owner);
    }
  }
  return found;
}

/**
 * The setup-node matchers still registered when a job's `steps` reach the one that runs darnit. A run step removes one
 * with a line `echo "::remove-matcher owner=<owner>::"`.
 */
export function matchersAtDarnit(steps: { uses?: string; run?: string }[]): string[] {
  const active = new Set<string>();
  for (const { uses, run = "" } of steps) {
    if (/\bnpx darnit\b/.test(run)) return [...active];
    if (uses?.startsWith("actions/setup-node@")) {
      if (uses !== "actions/setup-node@v7") throw new Error(`the matchers are those of setup-node@v7, not ${uses}`);
      for (const owner of Object.keys(SETUP_NODE_MATCHERS)) active.add(owner);
    }
    for (const [, owner] of run.matchAll(/^echo "::remove-matcher owner=([^,:"]+)::"$/gm)) active.delete(owner!);
  }
  throw new Error("no step runs darnit");
}

// timeout-minutes set per runner, the one form of expression the workflows use for it.
const BY_OS = /^\$\{\{ matrix\.os == '([\w.-]+)' && (\d+) \|\| (\d+) \}\}$/;
/** A job's timeout-minutes on runner `os`: a number, or `${{ matrix.os == '<os>' && <n> || <m> }}`; undefined for any other form. */
export function minutesOn(limit: unknown, os: string): number | undefined {
  if (typeof limit === "number") return limit;
  const m = typeof limit === "string" ? BY_OS.exec(limit) : null;
  return m ? Number(m[1] === os ? m[2] : m[3]) : undefined;
}
