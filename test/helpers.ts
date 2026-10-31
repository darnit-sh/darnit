import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

// Each run holds its syntax trees until they are collected, so a repeat collects them first.
setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;

/**
 * Milliseconds of CPU time `f` takes, which shared runners and parallel test files disturb less than wall time.
 * With `runs`, the least of up to that many runs, as noise only adds time. With a `budget`, it stops at the
 * first run under it, so a healthy check runs once, or once a run is over 1.5 times it, so a regression fails quickly.
 */
export async function cpuTime(f: () => unknown, runs = 1, budget?: number): Promise<number> {
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
 * The problem matchers `actions/setup-node@v7` registers on every run, by owner: the patterns in its .github/tsc.json,
 * eslint-stylish.json and eslint-compact.json at 949feb2413d6458794dcd2491c4babbbce0c15c1 (v7.1.0), the commit v7 names.
 */
export const SETUP_NODE_MATCHERS: Record<string, RegExp[]> = {
  tsc: [/^([^\s].*)[(:](\d+)[,:](\d+)(?:\):\s+|\s+-\s+)(error|warning|info)\s+TS(\d+)\s*:\s*(.*)$/],
  "eslint-stylish": [/^\s*([^\s].*)$/, /^\s+(\d+):(\d+)\s+(error|warning|info)\s+(.*)\s\s+(.*)$/],
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
