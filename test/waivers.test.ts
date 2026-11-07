import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { read, table } from "../scripts/waivers.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const tsx = join(ROOT, "node_modules", ".bin", "tsx");
const FIXTURE = "test/fixtures/waivers.json";
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const temp = async () => {
  const dir = await mkdtemp(join(tmpdir(), "darnit-waivers-"));
  tempDirs.push(dir);
  return dir;
};

// The gates as pr.yml runs them, with the body in the environment, for the plumbing the script adds.
const GATES = `. scripts/pr-common.sh
t=$(title_type); opt_out >/dev/null; p=$reason
body_reason "Allowlist: " Allowlist >/dev/null; a=$reason
body_reason "Coverage: " Coverage >/dev/null; c=$reason
body_reason "Ceiling: " Ceiling >/dev/null; g=$reason
printf '%s\\0' "$t" "$p" "$a" "$c" "$g"`;
function gates(title: string, body: string) {
  const env = { PATH: process.env.PATH, LC_ALL: "C.UTF-8", TITLE: title, BODY: body, GITHUB_STEP_SUMMARY: "/dev/null" };
  const [type, proof, allowlist, coverage, ceiling] = spawnSync("sh", ["-c", GATES], {
    cwd: ROOT,
    encoding: "utf8",
    env,
  }).stdout.split("\0");
  return { type, proof, allowlist, coverage, ceiling };
}

describe("each body goes to scripts/pr-common.sh as the gates get it", () => {
  const lines =
    "Proof: none, a long enough reason\nAllowlist: a long enough reason\nCoverage: a long enough reason\nCeiling: a long enough reason";
  it.each([
    ["ci: x", lines],
    ["ci: x", `\n\n${lines}\n\n\n`],
    ["ci: x", lines.replaceAll("\n", "\r\n") + "\r\n"],
    ["fix: x", `<!--\n${lines}\n-->`],
    ["ci(scan)!: x", `\`\`\`\n\`\`\`\n${lines}\n\`\`\``],
    ["ci: x", "\n\n\n"],
    ["docs: x", ""],
  ])("%j %j", async (title, body) => {
    expect(await read(title, body)).toEqual(gates(title, body));
  });

  it.runIf(process.platform === "linux")("in the runner's locale, where sed cuts a trailing U+3000", async () => {
    expect((await read("fix: x", "Proof: none, abcdefghi\u3000")).proof).toBe("");
    expect((await read("fix: x", "Proof: none, abcdefghij\u3000")).proof).toBe("abcdefghij");
  });

  it("on stdin, so a body over the 128 KB a variable may hold on Linux is read", async () => {
    const body = `${"\u65e5".repeat(60_000)}\nProof: none, the last line of a long body`;
    expect((await read("fix: x", body)).proof).toBe("the last line of a long body");
  });
});

const run = (args: string[], env: NodeJS.ProcessEnv = process.env) => {
  const r = spawnSync(tsx, ["scripts/waivers.ts", ...args], { cwd: ROOT, encoding: "utf8", env });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
const rows = (out: string) => out.split("\n").filter((l) => /^(Proof|Allowlist|Coverage|Ceiling)/.test(l));

describe("npm run waivers", () => {
  it("counts each line over the title types a gate reads it for, merged after the gate's pull request", () => {
    const r = run([FIXTURE]);
    expect(r.status).toBe(0);
    expect(r.out).toContain(`45 merged pull requests in "${FIXTURE}".\nCounts merged pull requests whose body holds`);
    expect(r.out).toContain("It does not read which files each changed");
    expect(r.out).not.toContain("warning");
    expect(rows(r.out)).toEqual([
      "Proof: none  fix feat refactor perf         2      14   14.3%  #102 #108  over 10%",
      "Proof: none  test ci                        3      24   12.5%  #137  over 10%",
      "Allowlist    ci                             1      19    5.3%  #174",
      "Coverage     ci                             1      17    5.9%  #176",
      "Ceiling      any                            1      17    5.9%  #208",
    ]);
  });

  it("starts each window after --from merged, where that is later than the gate's", () => {
    expect(rows(run([FIXTURE, "--from", "176"]).out)).toEqual([
      "Proof: none  fix feat refactor perf         0      11    0.0%  #176",
      "Proof: none  test ci                        0      18    0.0%  #176",
      "Allowlist    ci                             0      17    0.0%  #176",
      "Coverage     ci                             1      17    5.9%  #176",
      "Ceiling      any                            1      17    5.9%  #208",
    ]);
    expect(rows(run([FIXTURE, "--from=100"]).out)[0]).toBe(
      "Proof: none  fix feat refactor perf         2      14   14.3%  #102 #108  over 10%",
    );
  });

  it("warns, and counts no row, where the file lacks the pull request a gate's window starts after", async () => {
    const prs = JSON.parse(await readFile(FIXTURE, "utf8")) as { number: number }[];
    const dir = await temp();
    await writeFile(join(dir, "recent.json"), JSON.stringify(prs.filter((pr) => pr.number >= 150)));
    const recent = run([join(dir, "recent.json")]);
    for (const n of [102, 108, 137])
      expect(recent.out).toContain(
        `warning: #${n} is not a merged pull request in the file, whose lowest is #150: fetch with --limit 1000\n`,
      );
    expect(rows(recent.out)).toEqual([
      "Proof: none  fix feat refactor perf         -       -       -  #102 #108",
      "Proof: none  test ci                        -       -       -  #137",
      "Allowlist    ci                             1      19    5.3%  #174",
      "Coverage     ci                             1      17    5.9%  #176",
      "Ceiling      any                            1      17    5.9%  #208",
    ]);
    await writeFile(join(dir, "gap.json"), JSON.stringify(prs.filter((pr) => pr.number !== 174)));
    const gap = run([join(dir, "gap.json")]);
    expect(gap.out).toContain("warning: #174 is not a merged pull request in the file\n");
    expect(rows(gap.out)[2]).toBe("Allowlist    ci                             -       -       -  #174");
  });

  it("stops on --from that is not a merged pull request in the file, with the --limit hint only below it", () => {
    expect(run([FIXTURE, "--from", "106"])).toEqual({
      status: 1,
      out: "",
      err: 'waivers stopped: "--from #106 is not a merged pull request in the file"\n',
    });
    expect(run([FIXTURE, "--from", "50"]).err).toBe(
      'waivers stopped: "--from #50 is not a merged pull request in the file, whose lowest is #98: fetch with --limit 1000"\n',
    );
  });

  it("leaves out a pull request merged in the same second as the one its window starts after", async () => {
    const at = (s: number) => `2026-10-01T00:00:0${s}Z`;
    const pr = (number: number, s: number, body = "Allowlist: a long enough reason") => ({
      number,
      title: "ci: x",
      body,
      mergedAt: at(s),
    });
    const file = join(await temp(), "same.json");
    await writeFile(file, JSON.stringify([pr(174, 1), pr(180, 1), pr(181, 2), pr(182, 2, "")]));
    expect(rows(run([file]).out)[2]).toBe(
      "Allowlist    ci                             1       2   50.0%  #174  over 10%",
    );
  });

  it("notes when this machine's sed does not trim as the runner's does, as on macOS", async () => {
    const dir = await temp();
    const sed = execFileSync("sh", ["-c", "command -v sed"], { encoding: "utf8" }).trim();
    await writeFile(join(dir, "sed"), `#!/bin/sh\nLC_ALL=C exec ${sed} "$@"\n`);
    await chmod(join(dir, "sed"), 0o755);
    const r = run([FIXTURE], { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` });
    expect(r.out).toContain("note: this machine's shell tools keep a trailing Unicode space, such as U+3000");
    expect(r.out).toContain("macOS has no C.UTF-8 locale, so this note shows on every run there.");
  });

  it("marks a share over 10%, not one at it", () => {
    const row = (waived: number, window: number) =>
      table([{ line: "Coverage", types: ["ci"], after: [1], counts: { waived, window } }])[1];
    expect(row(1, 10)).toBe("Coverage     ci                             1      10   10.0%  #1");
    expect(row(2, 19)).toBe("Coverage     ci                             2      19   10.5%  #1  over 10%");
    expect(row(0, 0)).toBe("Coverage     ci                             0       0       -  #1");
  });

  it("refuses arguments it cannot use, escaped", () => {
    for (const args of [[], [FIXTURE, FIXTURE], [FIXTURE, "--from", "0"], [FIXTURE, "--to", "1"]]) {
      const r = run(args);
      expect(r.status).toBe(2);
      expect(r.err).toContain("gh pr list --state merged --limit 1000 --json number,title,body,mergedAt");
    }
    expect(run([FIXTURE, "--from", "1\u001b[2J"]).err).toContain('not 1\\u001b[2J"');
  });

  it("stops on a file it cannot read as gh's output, and prints none of it raw", async () => {
    const dir = await temp();
    const file = async (name: string, value: unknown) => {
      await writeFile(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
      return join(dir, name);
    };
    const pr = { number: 1, title: "ci: x", body: "", mergedAt: "2026-10-01T00:00:00Z" };
    const stops = {
      [join(dir, "missing.json")]: "ENOENT",
      [await file("hostile.json", "[x\u001b]8;;\u0007\u202e]")]: "[x\\u001b]8;;\\u0007\\u202e]",
      [await file("nobody.json", [{ ...pr, body: undefined }])]: "entry 0.body",
      [await file("unmerged.json", [{ ...pr, mergedAt: null }])]: "entry 0.mergedAt",
      [await file("when.json", [{ ...pr, mergedAt: "yesterday" }])]: "entry 0.mergedAt",
      [await file("zero.json", [{ ...pr, number: 0 }])]: "entry 0.number",
      [await file("half.json", [{ ...pr, number: 1.5 }])]: "entry 0.number",
      [await file("object.json", { prs: [pr] })]: "the file: Invalid input: expected array",
      [await file("empty.json", [])]: "the file lists no pull requests",
      [await file("twice.json", [pr, pr])]: "pull request #1 is listed twice",
      [await file("nul.json", [{ ...pr, body: "a\u0000b" }])]: "pull request #1 has a NUL in its body",
    };
    for (const [path, says] of Object.entries(stops)) {
      const r = run([path]);
      expect(r.status, path).toBe(1);
      expect(r.out).toBe("");
      expect(r.err).toMatch(/^waivers stopped: "/);
      expect(r.err).toContain(says);
      expect(r.err).not.toMatch(/[^\n\x20-\x7e]/);
    }
  });
});
