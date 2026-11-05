import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readIn, watch, type Case } from "../scripts/watchdog.js";
import { MAX_FILE_BYTES } from "../src/detect.js";

// Each case runs `node -e <script>`, so the verdict is checked in a second rather than on the 10 MB inputs.
const node = (name: string, script: string, code = 0, unread: Case["unread"] = () => undefined): Case => ({
  name,
  code,
  unread,
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

  it("kills a child that ignores SIGTERM", { timeout: 10_000 }, async () => {
    const stubborn = node("a stubborn child", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
    expect(await watch([stubborn], quick)).toEqual(["a stubborn child: did not end in 0.5 seconds and was killed"]);
  });

  it("passes children that end with the code their case expects", async () => {
    expect(await watch([node("findings", "process.exit(1)", 1), node("none", "")], quick)).toEqual([]);
  });

  it("does not take a child printing 21 MB for one that hung", async () => {
    const loud = node("a long report", "process.stdout.write('x'.repeat(21 * 2 ** 20) + '\\nread\\n')", 0, (out) =>
      out.endsWith("\nread\n") ? undefined : "no end",
    );
    expect(await watch([loud], { ...quick, limitMs: 20_000 })).toEqual([]);
  });

  it("names a child that ends with another code, by a signal, or cannot start, with the end of its stderr", async () => {
    const refusal = node("a refusal", "console.error('one\\ntwo\\nthree\\ndarnit: no plan'); process.exit(2)", 1);
    const cases = [refusal, node("a crash", "process.kill(process.pid, 'SIGKILL')")];
    expect(await watch(cases, { ...quick, atOnce: 1 })).toEqual([
      "a refusal: exited 2, not 1; stderr ends: two / three / darnit: no plan",
      "a crash: ended by SIGKILL",
    ]);
    expect(await watch([node("no program", "")], { ...quick, command: ["/nonexistent/node"] })).toEqual([
      "no program: could not run: spawn /nonexistent/node ENOENT",
    ]);
  });

  it("names a case that cannot be prepared, and removes each case's folder", async () => {
    const folders: string[] = [];
    const broken: Case = { ...node("a full disk", ""), args: () => Promise.reject(new Error("no space left")) };
    const kept: Case = { ...node("a folder", ""), args: (dir) => (folders.push(dir), Promise.resolve(["-e", ""])) };
    expect(await watch([broken, kept], quick)).toEqual(["a full disk: could not be prepared: no space left"]);
    expect(folders).toHaveLength(1);
    expect(existsSync(dirname(folders[0]!))).toBe(false);
  });

  it("fails a child that ends as expected but does not show it read its input", async () => {
    expect(await watch([node("an empty report", "", 0, readIn("main.go"))], quick)).toEqual([
      "an empty report: its output names main.go among no results",
    ]);
  });

  it(
    "passes darnit check on a file of MAX_FILE_BYTES, and fails it on one a byte over, which it does not read",
    { timeout: 60_000 },
    async () => {
      const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
      const command = [process.execPath, "--import", import.meta.resolve("tsx"), cli];
      const unit = "// o1 gpt-4\n";
      const sized = (bytes: number): Case => ({
        name: `main.go of ${bytes} bytes`,
        code: 0,
        unread: readIn("main.go"),
        args: async (dir) => {
          await writeFile(join(dir, "main.go"), unit.repeat(Math.floor(bytes / unit.length)).padEnd(bytes, " "));
          return ["check", dir];
        },
      });
      expect(
        await watch([sized(MAX_FILE_BYTES), sized(MAX_FILE_BYTES + 1)], {
          ...quick,
          command,
          limitMs: 30_000,
          atOnce: 1,
        }),
      ).toEqual([`main.go of ${MAX_FILE_BYTES + 1} bytes: its output lists main.go as not checked`]);
    },
  );
});
