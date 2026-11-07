import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { exitCodeForCheck, type Hit } from "../src/check.js";
import { MAX_FILE_BYTES } from "../src/detect.js";
import { exitCodeFor, type FixResult } from "../src/fix.js";
import { init, pinned, WORKFLOW } from "../src/init.js";
import { loadRecords } from "../src/records/load.js";
import { modelNames } from "../src/scan/astgrep.js";
import { LONG_LINE } from "../src/scan/mentions.js";
import { TIME_LIMIT_MINUTES } from "../src/tests.js";
import { atLeast } from "../src/versions.js";
import { exists, read, where } from "./docs.js";

// A constant's value as its declaration in a source file reads; undefined once the declaration changes shape.
const declared = async (file: string, at: RegExp) => at.exec(await read(file))?.slice(1);
const pkg = async () => JSON.parse(await read("package.json")) as { version: string; engines: { node: string } };
const cached = <T>(f: () => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= f());
};

const temps: string[] = [];
afterAll(() => Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))));
/** A git repository holding a copy of test/samples/<name>. */
async function sample(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "darnit-docs-"));
  temps.push(dir);
  await cp(fileURLToPath(new URL(`samples/${name}`, import.meta.url)), dir, { recursive: true });
  const git = (...args: string[]) =>
    promisify(execFile)("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  await git("init", "-q");
  await git("add", ".");
  await git("commit", "-q", "-m", "sample");
  return dir;
}
/** The CLI's exit code and output, run as a user would outside GitHub Actions. */
const darnit = (...args: string[]) =>
  new Promise<{ code: unknown; stdout: string }>((resolve) => {
    const env = { ...process.env, DARNIT_NO_UPDATE_CHECK: "1", GITHUB_ACTIONS: "", GITHUB_TOKEN: "", GH_TOKEN: "" };
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    execFile(process.execPath, ["--import", import.meta.resolve("tsx"), cli, ...args], { env }, (err, stdout) =>
      resolve({ code: err ? err.code : 0, stdout }),
    );
  });

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
  temps.push(dir);
  return (await darnit("fix", dir)).code;
});
// What init writes as darnit.yml for a repository whose package.json names openai, without its comments.
const config = cached(async () => {
  const dir = await sample("readme-config");
  await init(dir);
  return (await readFile(join(dir, "darnit.yml"), "utf8")).replace(/^#.*\n/gm, "");
});

type Doc = "README.md" | "SECURITY.md" | "RELEASING.md" | "ARCHITECTURE.md" | "CONTRIBUTING.md";
// The groups of the module map in test/architecture.test.ts, in its order: each one's floor ("islands" or "scripts"
// off the floors), the highest floor one off the floors may import, and its paths.
const groups = cached(async () =>
  (await read("test/architecture.test.ts"))
    .split("\n")
    .filter((l) => /^ {2}\w+: (at\(|\{ floor: NaN)/.test(l))
    .map((l) => ({
      floor: /: at\((\d+),/.exec(l)?.[1] ?? (l.includes('kind: "island"') ? "islands" : "scripts"),
      reach: /reach: (\d+)/.exec(l)?.[1],
      paths: [...(/(?:at\(\d+, |paths: )\[([^\]]*)\]/.exec(l)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((p) => p[1]!),
    })),
);
const group = async (path: string) => (await groups()).find((g) => g.paths.includes(path));
const floor = async (path: string) =>
  (await group(path))?.floor === "islands" ? "island" : (await group(path))?.floor;
// The paths the map puts on a floor that git tracks, in the map's order, as the floors table lists them.
const onFloor = async (at: string) =>
  (await groups())
    .filter((g) => g.floor === at)
    .flatMap((g) => g.paths)
    .filter(exists)
    .map((p) => `\`${p}\``)
    .join(", ");
// "a, b and c"
const listed = (items: string[]) => [items.slice(0, -1).join(", "), items.at(-1)].filter(Boolean).join(" and ");
// The npm scripts ci.yml runs that npm run check does not.
const ciOnly = async () => {
  const check = (JSON.parse(await read("package.json")) as { scripts: { check: string } }).scripts.check.split(" && ");
  const runs = [
    ...(await read(".github/workflows/ci.yml")).matchAll(/^ *(?:- )?run: (?:time )?(npm run [\w:-]+)$/gm),
  ].map((m) => m[1]!);
  return listed([...new Set(runs)].filter((r) => !check.includes(r)).map((r) => `\`${r}\``));
};
// A space in a pattern matches any run of spaces and line breaks, so rewrapping a paragraph keeps its match.
const loose = (at: RegExp, flags: string) => new RegExp(at.source.replaceAll(" ", "\\s+"), flags);
// The major versions of an action this repository's own workflows use, pinned as `<sha> # vN.x.y`.
const ours = async (action: string) => {
  const dir = new URL("../.github/workflows/", import.meta.url);
  const texts = await Promise.all((await readdir(dir)).map((f) => readFile(new URL(f, dir), "utf8")));
  const majors = texts.flatMap((t) =>
    [...t.matchAll(new RegExp(`uses: actions/${action}@[0-9a-f]{40} # (v\\d+)\\.`, "g"))].map((m) => m[1]),
  );
  return [...new Set(majors)].join(", ");
};
// The same pattern read from the workflow init writes.
const workflow = (at: RegExp) => ({ in: ["README.md"] as Doc[], at, is: () => [at.exec(WORKFLOW)?.[1]] });

// Each match's capture groups must read what `is` returns, from the code or config itself, with runs of whitespace
// counted as one space unless `raw`. One phrase per entry, so deleting any phrase fails the test.
const CHECKED: { in: Doc[]; at: RegExp; raw?: boolean; is: (m: RegExpExecArray) => unknown[] | Promise<unknown[]> }[] =
  [
    {
      in: ["README.md", "CONTRIBUTING.md"],
      at: /Needs Node (\S+) or newer/,
      is: async () => [/^>=(\d+(?:\.\d+)*)$/.exec((await pkg()).engines.node)?.[1]],
    },
    {
      in: ["README.md", "SECURITY.md"],
      at: /git (\S+) or newer/,
      is: async () => [
        (await declared("src/git.ts", /^const MIN_GIT: \[number, number\] = \[(\d+), (\d+)\];$/m))?.join("."),
      ],
    },
    { in: ["README.md", "RELEASING.md"], at: /Node ((?:\d+, )*\d+ and \d+)/, is: async () => [await nodes()] },
    {
      in: ["README.md"],
      at: /OpenAI: (\d+) retiring models/,
      is: async () => [
        new Set(
          (await loadRecords()).flatMap(({ record }) =>
            Object.values(record.detection.astGrepPatterns).flatMap(modelNames),
          ),
        ).size,
      ],
    },
    { in: ["README.md"], at: /line over (\S+) characters/, is: () => [LONG_LINE.toLocaleString("en-US")] },
    { in: ["README.md"], at: /files over (\S+) MB/, is: () => [MAX_FILE_BYTES / 1024 / 1024] },
    { in: ["README.md"], at: /takes over (\d+) minutes is stopped/, is: () => [TIME_LIMIT_MINUTES] },
    {
      in: ["README.md"],
      at: /waits at most (\S+) seconds/,
      is: async () => [Number((await declared("src/update.ts", /^const BUDGET_MS = (\d+);$/m))?.[0]) / 1000],
    },
    {
      in: ["README.md"],
      at: /^\| (\d+) \| nothing affected, or only unreviewed changes \|$/,
      is: () => [exitCodeForCheck([hit("candidate")])],
    },
    {
      in: ["README.md"],
      at: /^\| (\d+) \| affected call sites found for a reviewed or parser-verified change \|$/,
      is: () => [exitCodeForCheck([hit("reviewed")])],
    },
    {
      in: ["README.md"],
      at: /^\| (\d+) \| darnit itself failed, including on one file it failed to scan, or/,
      is: async () => [await refused()],
    },
    {
      in: ["README.md"],
      at: /could not be scanned`: its own call sites are not reported, every other file's are, and `check` exits (\d+)/,
      is: () => [
        exitCodeForCheck([], { files: 1, records: 1, skipped: [{ path: "a.ts", reason: "could not be scanned" }] }),
      ],
    },
    {
      in: ["README.md"],
      at: /^\| (\d+) \| done, or nothing to do/,
      is: () => [exitCodeFor({ records: [] } as unknown as FixResult)],
    },
    {
      in: ["README.md"],
      at: /^\| (\d+) \| the build or tests failed or timed out after the change/,
      is: () => [exitCodeFor(testsFailed)],
    },
    {
      in: ["README.md"],
      at: /^\| (\d+) \| darnit refused or failed, or a mistyped command or flag \|$/,
      is: async () => [await refused()],
    },
    { in: ["README.md"], at: /refuses \(exit (\d+)\)/, is: async () => [await refused()] },
    // The sample run below shows darnit leaving this call alone.
    {
      in: ["README.md"],
      at: /`anthropic\.messages\.create\(\{ max_tokens: (\d+) \}\)`/,
      is: async () => [
        /anthropic\.messages\.create\(\{[^}]*max_tokens: (\d+)/.exec(await read("test/samples/readme/chat.ts"))?.[1],
      ],
    },
    { in: ["README.md"], at: /^## darnit\.yml\n\n```yaml\n([^]*?)```$/, raw: true, is: async () => [await config()] },
    workflow(/cron: "([^"]+)"/),
    workflow(/node-version: (\d+)/),
    workflow(/uses: actions\/checkout@(v\d+)/),
    workflow(/uses: actions\/setup-node@(v\d+)/),
    { in: ["README.md"], at: /uses: actions\/upload-artifact@(v\d+)/, is: async () => [await ours("upload-artifact")] },
    {
      in: ["README.md"],
      at: /uses: actions\/download-artifact@(v\d+)/,
      is: async () => [await ours("download-artifact")],
    },
    // The version the README's fix --prepare and --publish example installs, and the file npm pack names after it.
    { in: ["README.md"], at: /darnit@(\d[\w.-]*\w)/, is: async () => [(await pkg()).version] },
    { in: ["README.md"], at: /darnit-(\d[\w.-]*\w)\.tgz/, is: async () => [(await pkg()).version] },
    { in: ["SECURITY.md"], at: /the newest (\S+) release/, is: async () => [await line()] },
    { in: ["SECURITY.md"], at: /pick up a new (\S+) release/, is: async () => [await line()] },
    { in: ["SECURITY.md"], at: /^\| Newest (\d+\.\d+)\.x \|/, is: async () => [await line()] },
    { in: ["SECURITY.md"], at: /^\| Older (\d+\.\d+)\.x \|/, is: async () => [await line()] },
    {
      in: ["SECURITY.md"],
      at: /from a final (\S+) release run `npx darnit@(\S+)`/,
      is: async () => [await line(), pinned(`${await line()}.0`)],
    },
    // History: the release it names is out already, or is the one being prepared.
    {
      in: ["RELEASING.md"],
      at: /from (\S+) on, `init` pins the minor \(`npx darnit@(\S+) check`\)/,
      is: async (m) => {
        const current = (await pkg()).version.replace(/-.*/, "");
        return [atLeast(current, m[1]!) ? m[1] : `${current} or older`, pinned(m[1]!)];
      },
    },
    {
      in: ["RELEASING.md"],
      at: /from \S+ on the major \(`npx darnit@(\S+) check`\)/,
      is: (m) => [pinned(/from (\S+)/.exec(m[0])![1]!)],
    },
    {
      in: ["RELEASING.md"],
      at: /`check` to exit (\d+) with a hit/,
      is: async () => [/"\$status" != (\d+)/.exec(await read("scripts/verify-release.sh"))?.[1]],
    },
    {
      in: ["CONTRIBUTING.md"],
      at: /what changed`, (\d+) characters at most/,
      is: async () => [(await declared("scripts/check-pr.sh", /^\[ "\$\{#TITLE\}" -le (\d+) \]/m))?.[0]],
    },
    { in: ["ARCHITECTURE.md"], at: /^\| `(src\/[^`]+)` \| (\w+) \|/, is: async (m) => [m[1], await floor(m[1]!)] },
    // A floor's row lists every tracked path the map puts on that floor, and no other.
    {
      in: ["ARCHITECTURE.md"],
      at: /^\| (\w+) \| ((?:`[^`]+`(?:, )?)+) \|/,
      is: async (m) => [m[1], await onFloor(m[1]!)],
    },
    {
      in: ["ARCHITECTURE.md"],
      at: /They may use floors (\d+) to (\d+)/,
      is: async () => ["0", (await group("src/corpus/"))?.reach],
    },
    {
      in: ["ARCHITECTURE.md"],
      at: /`scripts\/` may import islands and floors (\d+) to (\d+)/,
      is: async () => ["0", (await group("scripts/"))?.reach],
    },
    {
      in: ["ARCHITECTURE.md"],
      at: /^\| Coverage per folder of `src\/` \| at or above each line and branch percent in `([^`]+)`, measured by `([^`]+)`/,
      is: async () => [
        /^import thresholds from "\.\/([^"]+)"/m.exec(await read("vitest.config.ts"))?.[1],
        /^ *(?:- )?run: (npm test -- --coverage)\b/m.exec(await read(".github/workflows/ci.yml"))?.[1],
      ],
    },
    { in: ["CONTRIBUTING.md"], at: /CI also runs ([^]*?), measures coverage/, is: async () => [await ciOnly()] },
    { in: ["ARCHITECTURE.md"], at: /without a stack and exits (\d+)/, is: async () => [await refused()] },
    ...(
      [
        ["Lines per file in `src\\/`", "max-lines"],
        ["Lines per function", "max-lines-per-function"],
        ["Complexity per function", "complexity"],
        ["Nesting depth", "max-depth"],
        ["Parameters", "max-params"],
      ] as const
    ).map(([row, rule]) => ({
      in: ["ARCHITECTURE.md"] as Doc[],
      at: new RegExp(`^\\| ${row} \\| (\\d+)(?: \\(an options object beyond\\))? \\|$`),
      is: async () => [
        (await declared("scripts/limits.ts", new RegExp(`^  "?${rule}"?: \\["error", \\{ max: (\\d+)[ ,]`, "m")))?.[0],
      ],
    })),
    {
      in: ["ARCHITECTURE.md"],
      at: /none of (\d+) tokens or more/,
      is: async () => [(await declared("scripts/allowlist.ts", /^const MIN_TOKENS = "(\d+)";$/m))?.[0]],
    },
  ];

// Numbers no code or config holds. Each match accounts for every number inside it.
const UNCHECKED: { in: Doc[]; at: RegExp; why: string }[] = [
  { in: ["README.md"], at: /`src\/x\.ts\(1,1\): error TS2322: \.\.\.`/, why: "example compiler output" },
  {
    in: ["README.md"],
    at: /`DARNIT_NO_UPDATE_CHECK=1` \(or `NO_UPDATE_NOTIFIER=1`\)/,
    why: "example value: any non-empty value turns the check off",
  },
  {
    in: ["SECURITY.md"],
    at: /0\.1\.x and older/,
    why: "the release line before the newest, which nothing in the code names",
  },
  { in: ["SECURITY.md"], at: /We reply within 3 days\./, why: "a promise to reporters, not a setting" },
  { in: ["SECURITY.md"], at: /We aim to disclose within 90 days/, why: "a promise to reporters, not a setting" },
  { in: ["SECURITY.md"], at: /^[1-3]\. /, why: "step number" },
  { in: ["RELEASING.md"], at: /\(`0\.1\.5` after `0\.2\.0`\)/, why: "example of a patch to an older line" },
  {
    in: ["RELEASING.md"],
    at: /`init` in 0\.1\.0 run `npx darnit check` with no version/,
    why: "history: the release before pinning",
  },
  {
    in: ["RELEASING.md"],
    at: /from 1\.0\.0 on the major/,
    why: "the 1.0 boundary of the pin rule; the pin it names is checked",
  },
  { in: ["RELEASING.md"], at: /before 1\.0, a patch only adds/, why: "the 1.0 boundary of the versioning rule" },
  { in: ["RELEASING.md"], at: /`darnit@X` from 1\.0 on/, why: "the 1.0 boundary of the pin rule" },
  { in: ["RELEASING.md"], at: /From 1\.0 on, `init` pins the major/, why: "the 1.0 boundary of the pin rule" },
  {
    in: ["RELEASING.md"],
    at: /\(X\.Y\.0\) before 1\.0, README\.md's workflow examples/,
    why: "the 1.0 boundary of the pin rule",
  },
  { in: ["RELEASING.md"], at: /`rc\.N\+1`/, why: "the next candidate number" },
  {
    in: ["CONTRIBUTING.md"],
    at: /about 300 changed source lines at most/,
    why: "a size a change holds to, not a setting",
  },
  { in: ["CONTRIBUTING.md"], at: /^[1-4]\. \*\*/, why: "step number" },
];

// Each `$ npx darnit check` block, in order, run for real on test/samples/<name>, then each later command in the
// block on the same copy. Every line the block shows must be printed, in that order.
const SAMPLES: Record<Doc, string[]> = {
  "README.md": ["readme", "readme-models"],
  "SECURITY.md": [],
  "RELEASING.md": [],
  "ARCHITECTURE.md": [],
  "CONTRIBUTING.md": [],
};

// A number, with any unit or hyphen after it (20MB, 15-minute, 2020-10-05), a v before it (v7), and after a dot or
// underscore that follows no letter or digit (.5, _20 MB_), but not inside a name such as gpt-4, gpt-4.1, o1 or TS2322.
const NUMBER = /(?<![\p{L}\p{N}]|[\p{L}\p{N}_][.-])v?\d+(?:[.,]\d+)*/gu;

async function samples(file: Doc, text: string, covered: [number, number][], problems: string[]) {
  const blocks = [...text.matchAll(/^```\n(\$ npx darnit check\n[^]*?)^```$/gm)];
  if (blocks.length !== SAMPLES[file].length)
    problems.push(`${file}: ${blocks.length} sample runs, but SAMPLES names ${SAMPLES[file].length} folders`);
  for (const [i, block] of blocks.entries()) {
    const name = SAMPLES[file][i];
    if (!name) continue;
    const dir = await sample(name);
    let at = block.index + "```\n".length;
    for (const run of block[1]!.split(/^(?=\$ npx darnit )/m)) {
      const [prompt, ...shown] = run.replace(/\n$/, "").split("\n");
      const command = prompt!.replace("$ npx darnit ", "");
      const printed = (await darnit(...command.split(" "), dir)).stdout.split("\n");
      at += prompt!.length + 1;
      let next = 0;
      for (const l of shown) {
        const found = printed.indexOf(l, next);
        if (found === -1)
          problems.push(`${where(text, file, at)}: not printed by \`darnit ${command}\` on test/samples/${name}`);
        else covered.push([at, at + l.length]);
        next = found === -1 ? next : found + 1;
        at += l.length + 1;
      }
    }
  }
}

describe("numbers in the docs match the code", () => {
  // README's checks start the CLI five times, one after another: about 20 seconds on a busy macOS runner.
  it.each(Object.keys(SAMPLES) as Doc[])(
    "every number in %s is checked against its source or listed with a reason",
    { timeout: 120_000 },
    async (file) => {
      const text = await read(file);
      const covered: [number, number][] = [];
      const problems: string[] = [];
      for (const { at } of [...CHECKED, ...UNCHECKED])
        if (/(?<!\\)\|/.test(at.source)) problems.push(`${at} holds more than one phrase`);
      for (const { at, raw, is } of CHECKED.filter((c) => c.in.includes(file))) {
        const flat = (s: unknown) => (raw ? String(s) : String(s).replace(/\s+/g, " ").trim());
        const matches = [...text.matchAll(loose(at, "gmd"))];
        if (!matches.length) problems.push(`${file}: no longer says ${at}`);
        for (const m of matches) {
          const said = m.slice(1).map(flat);
          const want = (await is(m)).map(flat);
          if (said.join(" | ") !== want.join(" | "))
            problems.push(`${where(text, file, m.index)}: says ${said.join(", ")}, its source says ${want.join(", ")}`);
          covered.push(...m.indices!.slice(1).filter((s) => s !== undefined));
        }
      }
      for (const { at } of UNCHECKED.filter((u) => u.in.includes(file))) {
        const matches = [...text.matchAll(loose(at, "gm"))];
        if (!matches.length) problems.push(`${file}: no longer says ${at}`);
        covered.push(...matches.map((m) => [m.index, m.index + m[0].length] as [number, number]));
      }
      await samples(file, text, covered, problems);
      for (const m of text.matchAll(NUMBER)) {
        const end = m.index + m[0].length;
        if (!covered.some(([s, e]) => s <= m.index && end <= e))
          problems.push(
            `${where(text, file, m.index)}: ${m[0]} is neither checked nor listed in test/docs-facts.test.ts`,
          );
      }
      expect(problems).toEqual([]);
    },
  );

  it("ARCHITECTURE.md's floors table has one row per floor of the module map, in its order", async () => {
    const rows = [...(await read("ARCHITECTURE.md")).matchAll(/^\| (\w+) \| `/gm)].map((m) => m[1]);
    expect(rows).toEqual([...new Set((await groups()).map((g) => g.floor).filter((f) => f !== "scripts"))]);
  });

  it("finds every number, with or without a unit, but not inside names", () => {
    const md =
      "Node 22.12, 5,000 and `darnit@0.2` (1,1); 15-minute, 20MB, 3000ms, 5,000-character, 2020-10-05, @v7, exit -1, _20 MB_, .5 seconds; gpt-4, gpt-4.1, o3-2025-04-16, o1, TS2322 and rc.N+1.";
    expect([...md.matchAll(NUMBER)].map((m) => m[0])).toEqual([
      "22.12",
      "5,000",
      "0.2",
      "1,1",
      "15",
      "20",
      "3000",
      "5,000",
      "2020",
      "v7",
      "1",
      "20",
      "5",
      "1",
    ]);
  });
});
