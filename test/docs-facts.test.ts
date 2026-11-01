import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { exitCodeForCheck, type Hit } from "../src/check.js";
import { MAX_FILE_BYTES } from "../src/detect.js";
import { exitCodeFor, type FixResult } from "../src/fix.js";
import { MIN_GIT } from "../src/git.js";
import { pinned } from "../src/init.js";
import { loadRecords } from "../src/records/load.js";
import { modelNames } from "../src/scan/astgrep.js";
import { LONG_LINE } from "../src/scan/mentions.js";
import { TIME_LIMIT_MINUTES } from "../src/tests.js";
import { BUDGET_MS } from "../src/update.js";

const read = (file: string) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const pkg = async () => JSON.parse(await read("package.json")) as { version: string; engines: { node: string } };
const cached = <T>(f: () => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= f());
};

// The release line the newest release is on: 0.2 for 0.2.0-rc.1 or 0.2.3.
const line = async () => /^\d+\.\d+/.exec((await pkg()).version)?.[0];
const nodes = async () => {
  type CI = { jobs: { test: { strategy: { matrix: { node: number[] } } } } };
  const node = (parse(await read(".github/workflows/ci.yml")) as CI).jobs.test.strategy.matrix.node;
  return `${node.slice(0, -1).join(", ")} and ${node.at(-1)}`;
};
const hit = (status: string) => ({ record: { status } }) as unknown as Hit;
const testsFailed = { records: [], tests: { kind: "tests", passed: false } } as unknown as FixResult;
// What the CLI exits with when it refuses: fix outside a git repository.
const refused = cached(async () => {
  const dir = await mkdtemp(join(tmpdir(), "darnit-docs-"));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  try {
    await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "fix", dir], { env: { ...process.env, DARNIT_NO_UPDATE_CHECK: "1" } });
    return 0;
  } catch (err) {
    return (err as { code?: unknown }).code;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

type Doc = "README.md" | "SECURITY.md" | "RELEASING.md";
// A space in a pattern matches any run of spaces and line breaks, so rewrapping a paragraph keeps its match.
const loose = (at: RegExp, flags: string) => new RegExp(at.source.replaceAll(" ", "\\s+"), flags);

// Each match's capture groups must read what `is` returns, from the code or config itself.
const CHECKED: { in: Doc[]; at: RegExp; is: (m: RegExpExecArray) => unknown[] | Promise<unknown[]> }[] = [
  { in: ["README.md"], at: /Needs Node (\S+) or newer/, is: async () => [/^>=(\d+(?:\.\d+)*)$/.exec((await pkg()).engines.node)?.[1]] },
  { in: ["README.md", "SECURITY.md"], at: /git (\S+) or newer/, is: () => [MIN_GIT.join(".")] },
  { in: ["README.md", "RELEASING.md"], at: /Node ((?:\d+, )*\d+ and \d+)/, is: async () => [await nodes()] },
  {
    in: ["README.md"],
    at: /OpenAI: (\d+) retiring models/,
    is: async () => [new Set((await loadRecords()).flatMap(({ record }) => Object.values(record.detection.astGrepPatterns).flatMap(modelNames))).size],
  },
  { in: ["README.md"], at: /line over (\S+) characters/, is: () => [LONG_LINE.toLocaleString("en-US")] },
  { in: ["README.md"], at: /files over (\S+) MB/, is: () => [MAX_FILE_BYTES / 1024 / 1024] },
  { in: ["README.md"], at: /takes over (\d+) minutes is stopped/, is: () => [TIME_LIMIT_MINUTES] },
  { in: ["README.md"], at: /waits at most (\S+) seconds/, is: () => [BUDGET_MS / 1000] },
  { in: ["README.md"], at: /^\| (\d+) \| nothing affected, or only unreviewed changes \|$/, is: () => [exitCodeForCheck([hit("candidate")])] },
  { in: ["README.md"], at: /^\| (\d+) \| affected call sites found for a reviewed or parser-verified change \|$/, is: () => [exitCodeForCheck([hit("reviewed")])] },
  { in: ["README.md"], at: /^\| (\d+) \| darnit itself failed, including on one file it failed to scan, or/, is: async () => [await refused()] },
  {
    in: ["README.md"],
    at: /could not be scanned`: its own call sites are not reported, every other file's are, and `check` exits (\d+)/,
    is: () => [exitCodeForCheck([], { files: 1, records: 1, skipped: [{ path: "a.ts", reason: "could not be scanned" }] })],
  },
  { in: ["README.md"], at: /^\| (\d+) \| done, or nothing to do/, is: () => [exitCodeFor({ records: [] } as unknown as FixResult)] },
  { in: ["README.md"], at: /^\| (\d+) \| the build or tests failed or timed out after the change/, is: () => [exitCodeFor(testsFailed)] },
  { in: ["README.md"], at: /^\| (\d+) \| darnit refused or failed, or a mistyped command or flag \|$/, is: async () => [await refused()] },
  { in: ["README.md"], at: /refuses \(exit (\d+)\)/, is: async () => [await refused()] },
  { in: ["SECURITY.md"], at: /(?:the newest|pick up a new) (\S+) release/, is: async () => [await line()] },
  { in: ["SECURITY.md"], at: /^\| (?:Newest|Older) (\d+\.\d+)\.x \|/, is: async () => [await line()] },
  { in: ["SECURITY.md"], at: /from a final (\S+) release run `npx darnit@(\S+)`/, is: async () => [await line(), pinned(`${await line()}.0`)] },
  { in: ["RELEASING.md"], at: /from (\S+) on, `init` pins the minor \(`npx darnit@(\S+) check`\)/, is: (m) => [m[1], pinned(m[1]!)] },
  { in: ["RELEASING.md"], at: /from (\S+) on the major \(`npx darnit@(\S+) check`\)/, is: (m) => [m[1], pinned(m[1]!)] },
  { in: ["RELEASING.md"], at: /`check` to exit (\d+) with a hit/, is: async () => [/"\$status" != (\d+)/.exec(await read("scripts/verify-release.sh"))?.[1]] },
];

// Numbers no code or config holds. Each match accounts for every number inside it.
const UNCHECKED: { in: Doc[]; at: RegExp; why: string }[] = [
  { in: ["README.md"], at: /`anthropic\.messages\.create\(\{ max_tokens: 1024 \}\)`/, why: "example code a user might have" },
  { in: ["README.md"], at: /`src\/x\.ts\(1,1\): error TS2322: \.\.\.`/, why: "example compiler output" },
  { in: ["README.md"], at: /`DARNIT_NO_UPDATE_CHECK=1` \(or `NO_UPDATE_NOTIFIER=1`\)/, why: "example value: any non-empty value turns the check off" },
  { in: ["SECURITY.md"], at: /0\.1\.x and older/, why: "the release line before the newest, which nothing in the code names" },
  { in: ["SECURITY.md"], at: /We reply within 3 days\.|We aim to disclose within 90 days/, why: "a promise to reporters, not a setting" },
  { in: ["SECURITY.md"], at: /^[1-3]\. /, why: "step number" },
  { in: ["RELEASING.md"], at: /\(`0\.1\.5` after `0\.2\.0`\)/, why: "example of a patch to an older line" },
  { in: ["RELEASING.md"], at: /`init` in 0\.1\.0 run `npx darnit check` with no version/, why: "history: the release before pinning" },
  { in: ["RELEASING.md"], at: /before 1\.0, a patch only adds|`darnit@X` from 1\.0 on/, why: "the 1.0 boundary of the pin rule, checked through `npx darnit@1` above" },
  { in: ["RELEASING.md"], at: /`rc\.N\+1`/, why: "the next candidate number" },
];

// A number on its own, not part of a name such as gpt-4, o1, v7 or TS2322.
const NUMBER = /(?<![\w.-])\d+(?:[.,]\d+)*(?![\w-])/g;

/** The file with fenced code blocks blanked, so offsets and line numbers still match the file. */
const prose = (md: string) => {
  let fenced = false;
  return md
    .split("\n")
    .map((l) => {
      const fence = /^\s*```/.test(l);
      if (fence) fenced = !fenced;
      return fence || fenced ? "" : l;
    })
    .join("\n");
};

const where = (text: string, file: string, at: number) => {
  const n = text.slice(0, at).split("\n").length;
  return `${file}:${n}: ${text.split("\n")[n - 1]!.trim()}`;
};

describe("numbers in the docs match the code", () => {
  it.each(["README.md", "SECURITY.md", "RELEASING.md"] as Doc[])("every number in %s's prose is checked against its source or listed with a reason", async (file) => {
    const text = prose(await read(file));
    const covered: [number, number][] = [];
    const problems: string[] = [];
    for (const { at, is } of CHECKED.filter((c) => c.in.includes(file))) {
      const matches = [...text.matchAll(loose(at, "gmd"))];
      if (!matches.length) problems.push(`${file}: no longer says ${at}`);
      for (const m of matches) {
        const said = m.slice(1).map((s) => s?.replace(/\s+/g, " "));
        const want = (await is(m)).map(String);
        if (said.join(" | ") !== want.join(" | ")) problems.push(`${where(text, file, m.index)}: says ${said.join(", ")}, its source says ${want.join(", ")}`);
        covered.push(...m.indices!.slice(1).filter((s) => s !== undefined));
      }
    }
    for (const { at } of UNCHECKED.filter((u) => u.in.includes(file))) {
      const matches = [...text.matchAll(loose(at, "gm"))];
      if (!matches.length) problems.push(`${file}: no longer says ${at}`);
      covered.push(...matches.map((m) => [m.index, m.index + m[0].length] as [number, number]));
    }
    for (const m of text.matchAll(NUMBER)) {
      const end = m.index + m[0].length;
      if (!covered.some(([s, e]) => s <= m.index && end <= e)) problems.push(`${where(text, file, m.index)}: ${m[0]} is neither checked nor listed in test/docs-facts.test.ts`);
    }
    expect(problems).toEqual([]);
  });

  it("finds numbers only in prose, whole, and not inside names", () => {
    const md = "Node 22.12, 5,000 and `darnit@0.2` (1,1); gpt-4, gpt-4.1, o1, v7, TS2322 and rc.N+1.\n```\nexit 3\n```\n";
    expect([...prose(md).matchAll(NUMBER)].map((m) => m[0])).toEqual(["22.12", "5,000", "0.2", "1,1", "1"]);
  });
});
