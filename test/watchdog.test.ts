import { describe, expect, it } from "vitest";
import { watch, type Case } from "../scripts/watchdog.js";

// Each case runs `node -e <script>`, so the verdict is checked in a second rather than on the 10 MB inputs.
const node = (name: string, script: string, code = 0): Case => ({
  name,
  code,
  args: () => Promise.resolve(["-e", script]),
});
const quick = { command: [process.execPath], limitMs: 500, log: () => {} };

describe("scripts/watchdog.ts", () => {
  it("kills a child that never ends at the limit, names its input, and starts no case after it", async () => {
    const start = Date.now();
    const failures = await watch([node("a loop", "for (;;) {}"), node("the next", "")], { ...quick, atOnce: 1 });
    expect(failures).toEqual([
      "a loop: did not end in 0.5 seconds and was killed",
      "the next: not run, as a loop was killed",
    ]);
    expect(Date.now() - start).toBeLessThan(10_000);
  });

  it("passes children that end with the code their case expects", async () => {
    expect(await watch([node("findings", "process.exit(1)", 1), node("none", "")], quick)).toEqual([]);
  });

  it("names a child that ends with another code, by a signal, or cannot start", async () => {
    const cases = [node("a refusal", "process.exit(2)", 1), node("a crash", "process.kill(process.pid, 'SIGKILL')")];
    expect(await watch(cases, { ...quick, atOnce: 1 })).toEqual([
      "a refusal: exited 2, not 1",
      "a crash: ended by SIGKILL",
    ]);
    expect(await watch([node("no program", "")], { ...quick, command: ["/nonexistent/node"] })).toEqual([
      "no program: could not run: spawn /nonexistent/node ENOENT",
    ]);
  });
});
