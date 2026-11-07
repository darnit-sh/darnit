import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bodyReason, count, reasons, table } from "../scripts/waivers.js";
import { slowdown } from "./helpers.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const tsx = join(ROOT, "node_modules", ".bin", "tsx");
const FIXTURE = "test/fixtures/waivers.json";
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// Each gate's own lines: opt_out as check-proof.sh and check-refactor.sh call it, the Allowlist line as
// check-refactor.sh reads it and the Coverage line as check-coverage.sh does. GitHub passes a null body as "".
const GATES = `. scripts/pr-common.sh
opt_out >/dev/null; proof=$reason
reason=; if [ "$(title_type)" = ci ]; then body_reason "Allowlist: " Allowlist >/dev/null; fi; allowlist=$reason
reason=; [ "$(title_type)" = ci ] && body_reason "Coverage: " Coverage >/dev/null; coverage=$reason
printf '%s\\0' "$proof" "$allowlist" "$coverage"`;
function gates(title: string, body: string | null) {
  const r = spawnSync("sh", ["-c", GATES], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, TITLE: title, BODY: body ?? "", GITHUB_STEP_SUMMARY: "/dev/null" },
  });
  expect(r.status, r.stderr).toBe(0);
  const [proof, allowlist, coverage] = r.stdout.split("\0");
  return { "Proof: none": proof, Allowlist: allowlist, Coverage: coverage };
}

type Case = { name: string; title?: string; body: string | null; carries: string[] };
const P = ["Proof: none"];
const BOTH = ["Allowlist", "Coverage"];
const ciBody = "Allowlist: a block stays for now\nCoverage: the folder moved away";
const CASES: Case[] = [
  { name: "a plain line", body: "Proof: none, a docs-only change", carries: P },
  { name: "CRLF line endings", body: "Summary\r\n\r\nProof: none, moves a script only\r\n", carries: P },
  { name: "a carriage return inside the prefix", body: "Proof: no\rne, the gate drops every CR", carries: P },
  { name: "an HTML comment hides the line", body: "<!--\nProof: none, the template's own example\n-->", carries: [] },
  {
    name: "a comment closed earlier on the line",
    body: "<!-- note -->Proof: none, after a closed comment",
    carries: P,
  },
  {
    name: "a comment hides the end of the reason",
    body: "Proof: none, short <!-- the rest is hidden -->",
    carries: [],
  },
  {
    name: "a comment closing mid line",
    body: "<!-- start\nstill hidden --> Proof: none, not at column 1",
    carries: [],
  },
  { name: "a fenced block", body: "```\nProof: none, inside a fence\n```", carries: [] },
  {
    name: "an indented tilde fence, then a line after it",
    body: "  ~~~~ text\nProof: none, inside tildes\n~~~~~  \nProof: none, after the fence closes",
    carries: P,
  },
  { name: "an unclosed fence hides the rest", body: "```sh\nProof: none, never closed fence", carries: [] },
  {
    name: "a shorter, other or labelled fence does not close",
    body: "````\n```\n~~~~\n``` js\nProof: none, still in the fence\n````\nProof: none, now outside it",
    carries: P,
  },
  { name: "a shorter fence does not close", body: "````\n```\nProof: none, still inside the fence\n````", carries: [] },
  { name: "tildes do not close backticks", body: "```\n~~~\nProof: none, still inside the fence\n```", carries: [] },
  {
    name: "a labelled fence does not close",
    body: "```\n``` js\nProof: none, still inside the fence\n```",
    carries: [],
  },
  { name: "four spaces open no fence", body: "    ```\nProof: none, no fence opened above", carries: P },
  { name: "a fence inside a comment", body: "<!--\n```\n-->\nProof: none, after the comment", carries: P },
  { name: "a comment inside a fence", body: "```\n<!--\n```\nProof: none, the comment was fenced", carries: P },
  ...[
    " Proof: none, a leading space here",
    "\tProof: none, a leading tab here",
    "Proof: None, a capital letter here",
    "proof: none, lower case here",
    "Proof: none,no space after the comma",
    "Proof:  none, two spaces here",
    "> Proof: none, quoted here",
    "- Proof: none, a list item here",
    "**Proof: none, in bold here**",
  ].map((body) => ({ name: `the lookalike ${JSON.stringify(body)}`, body, carries: [] })),
  { name: "only the first line counts", body: "Proof: none, short\nProof: none, a long enough reason", carries: [] },
  { name: "ten characters", body: "Proof: none, 0123456789", carries: P },
  { name: "nine characters", body: "Proof: none, 012345678", carries: [] },
  { name: "trailing whitespace is not counted", body: "Proof: none, 012345678 \t ", carries: [] },
  { name: "leading spaces are counted", body: "Proof: none,      abcde", carries: P },
  { name: "nine check marks", body: `Proof: none, ${"\u2713".repeat(9)}`, carries: [] },
  { name: "ten check marks", body: `Proof: none, ${"\u2713".repeat(10)}`, carries: P },
  { name: "nine emoji", body: `Proof: none, ${"\u{1f600}".repeat(9)}`, carries: [] },
  { name: "ten emoji", body: `Proof: none, ${"\u{1f600}".repeat(10)}`, carries: P },
  { name: "combining marks count as characters", body: `Proof: none, ${"e\u0301".repeat(5)}`, carries: P },
  { name: "Japanese", body: "Proof: none, 日本語で書いた理由です", carries: P },
  { name: "backticks", body: "Proof: none, `npm run` only", carries: P },
  { name: "an empty body", body: "", carries: [] },
  { name: "a null body", body: null, carries: [] },
  { name: "Proof whatever the type", title: "docs: x", body: "Proof: none, a docs change", carries: P },
  { name: "Allowlist and Coverage in a ci change", title: "ci: x", body: ciBody, carries: BOTH },
  { name: "with a scope and a bang", title: "ci(scan)!: x", body: ciBody, carries: BOTH },
  { name: "on the first line of the title", title: "ci: x\nfix: y", body: ciBody, carries: BOTH },
  ...["fix: x", "CI: x", "cis: x", " ci: x", "ci:x", "ci(Scan): x", ""].map((title) => ({
    name: `the title ${JSON.stringify(title)}`,
    title,
    body: ciBody,
    carries: [],
  })),
  { name: "a short Allowlist reason", title: "ci: x", body: "Allowlist: too short", carries: [] },
  { name: "no space after the colon", title: "ci: x", body: "Allowlist:a long enough reason", carries: [] },
  {
    name: "all three",
    title: "ci: x",
    body: `Proof: none, the checks only\n${ciBody}`,
    carries: [...P, ...BOTH],
  },
];

describe("the count reads each line as its gate does", () => {
  it.each(CASES)("$name", ({ title = "fix: x", body, carries }) => {
    const ts = reasons({ title, body });
    const sh = gates(title, body);
    // The gates show the reason with backticks made quotes.
    expect(Object.fromEntries(Object.entries(ts).map(([k, v]) => [k, v.replaceAll("`", "'")]))).toEqual(sh);
    expect(Object.keys(ts).filter((k) => ts[k as keyof typeof ts])).toEqual(carries);
  });
});

const run = (...args: string[]) => {
  const r = spawnSync(tsx, ["scripts/waivers.ts", ...args], { cwd: ROOT, encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

describe("npm run waivers", () => {
  it("prints a row per line over the window since its gate came in", () => {
    expect(run(FIXTURE)).toEqual({
      status: 0,
      out: [
        `23 merged pull requests in "${FIXTURE}"`,
        "Line           Waived   Merged   Share     From",
        "Proof: none         3       22   13.6%     #102  over 10%",
        "Allowlist           1       16    6.3%     #174",
        "Coverage            1       14    7.1%     #176",
        "",
      ].join("\n"),
      err: "",
    });
  });

  it("starts the window at --from where that is later than the gate", () => {
    expect(run(FIXTURE, "--from", "176").out.split("\n").slice(2, 5)).toEqual([
      "Proof: none         1       14    7.1%     #176",
      "Allowlist           0       14    0.0%     #176",
      "Coverage            1       14    7.1%     #176",
    ]);
    expect(run(FIXTURE, "--from=300").out).toContain("Proof: none         0        0       -     #300\n");
  });

  it("marks a share over 10%, not one at it", () => {
    const row = (waived: number, window: number) => table([{ label: "Coverage", from: 1, waived, window }])[1];
    expect(row(1, 10)).toBe("Coverage            1       10   10.0%       #1");
    expect(row(2, 19)).toBe("Coverage            2       19   10.5%       #1  over 10%");
    expect(row(0, 0)).toBe("Coverage            0        0       -       #1");
  });

  it("refuses arguments it cannot use, escaped", () => {
    for (const args of [[], [FIXTURE, FIXTURE], [FIXTURE, "--from", "0"], [FIXTURE, "--to", "1"]]) {
      const r = run(...args);
      expect(r.status).toBe(2);
      expect(r.err).toContain("usage: tsx scripts/waivers.ts");
    }
    expect(run(FIXTURE, "--from", "1\u001b[2J").err).toContain('not 1\\u001b[2J"');
  });

  it("stops on a file it cannot read as gh's output, and prints none of it raw", async () => {
    const dir = await mkdtemp(join(tmpdir(), "darnit-waivers-"));
    tempDirs.push(dir);
    const file = async (name: string, text: string) => {
      await writeFile(join(dir, name), text);
      return join(dir, name);
    };
    const pr = { number: 1, title: "ci: x", body: "" };
    const stops = {
      [join(dir, "missing.json")]: "ENOENT",
      [await file("hostile.json", "[x\u001b]8;;\u0007\u202e]")]: "[x\\u001b]8;;\\u0007\\u202e]",
      [await file("nobody.json", JSON.stringify([{ number: 1, title: "x" }]))]: "entry 0.body",
      [await file("object.json", JSON.stringify({ prs: [pr] }))]: "the file: Invalid input: expected array",
      [await file("twice.json", JSON.stringify([pr, pr]))]: "pull request #1 is listed twice",
    };
    for (const [path, says] of Object.entries(stops)) {
      const r = run(path);
      expect(r.status).toBe(1);
      expect(r.out).toBe("");
      expect(r.err).toMatch(/^waivers stopped: "/);
      expect(r.err).toContain(says);
      expect(r.err).not.toMatch(/[^\n\x20-\x7e]/);
    }
  });

  it("counts a pull request once, however many lines it holds", () => {
    const body = "Proof: none, a long enough reason\nProof: none, a second line";
    expect(count([{ number: 200, title: "ci: x", body }])[0]).toEqual({
      label: "Proof: none",
      from: 102,
      waived: 1,
      window: 1,
    });
  });
});

it("reads a body in time linear in its size, comments and fences included", { tags: ["cpu-time"] }, async () => {
  const hostile = (n: number) => `${"<!-- a -->".repeat(n)}\n${"```\n".repeat(n)}Proof: none, a long enough reason`;
  const [small, large] = [hostile(10_000), hostile(80_000)];
  const time = await slowdown(
    () => bodyReason(large, "Proof: none, "),
    () => bodyReason(small, "Proof: none, "),
    16,
  );
  expect(time).toBeLessThan(16);
});
