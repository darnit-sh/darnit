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
