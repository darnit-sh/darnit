// Runs the built CLI on the largest input darnit accepts, each run a child process killed outright at LIMIT_MS.
// A time limit inside the process cannot stop a synchronous loop, as its timer never runs; only a killed child
// fails and names the input that hung. Run after `npm run build`: npx tsx scripts/watchdog.ts
import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MAX_FILE_BYTES } from "../src/detect.js";
import { CAPS } from "../src/plan.js";
import { loadRecords } from "../src/records/load.js";

// About twice the slowest case measured, three at once; a case takes up to 3 GB, hence three at once.
const LIMIT_MS = 300_000;
const AT_ONCE = 3;
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const ENV = {
  ...process.env,
  DARNIT_NO_UPDATE_CHECK: "1",
  GITHUB_ACTIONS: "",
  GITHUB_TOKEN: "",
  GH_TOKEN: "",
  SSH_AUTH_SOCK: "",
};

/**
 * One run: its input, named; the arguments it is run with, after writing what it reads to `dir`; the exit code it
 * ends with; and why its output does not show it read its input, or undefined when it does.
 */
export type Case = {
  name: string;
  args: (dir: string) => Promise<string[]>;
  code: number;
  unread: (out: string) => string | undefined;
};
type Options = { limitMs?: number; atOnce?: number; command?: string[]; log?: (line: string) => void };
type Ended = { ms: number; code: number | null; signal: string | null; killed: boolean; error?: string };

/** `command` run with its output in files in `dir`, not pipes, so a child printing megabytes never waits on a reader. */
async function run(command: string[], limitMs: number, dir: string): Promise<Ended> {
  const [out, err] = await Promise.all([open(join(dir, "stdout"), "w"), open(join(dir, "stderr"), "w")]);
  const start = Date.now();
  try {
    return await new Promise<Ended>((done) => {
      const options: SpawnOptions = {
        env: ENV,
        stdio: ["ignore", out.fd, err.fd],
        timeout: limitMs,
        killSignal: "SIGKILL",
      };
      const child = spawn(command[0]!, command.slice(1), options);
      const ended = (rest: Omit<Ended, "ms" | "killed">) =>
        done({ ms: Date.now() - start, killed: child.killed, ...rest });
      child.on("error", (e) => ended({ code: null, signal: null, error: e.message }));
      child.on("exit", (code, signal) => ended({ code, signal }));
    });
  } finally {
    await Promise.all([out.close(), err.close()]);
  }
}

/** What went wrong with a run that should end with `code`, or undefined when it did. */
function problem(e: Ended, code: number, limitMs: number): string | undefined {
  if (e.killed) return `did not end in ${limitMs / 1000} seconds and was killed`;
  if (e.error !== undefined) return `could not run: ${e.error}`;
  if (e.signal !== null) return `ended by ${e.signal}`;
  return e.code === code ? undefined : `exited ${String(e.code)}, not ${code}`;
}

/** Why case `c` failed, with the end of what it wrote to stderr, or undefined when it ended as it should and read its input. */
async function verdict(c: Case, e: Ended, limitMs: number, dir: string): Promise<string | undefined> {
  const wrong = problem(e, c.code, limitMs) ?? c.unread(await readFile(join(dir, "stdout"), "utf8"));
  if (wrong === undefined) return undefined;
  const tail = (await readFile(join(dir, "stderr"), "utf8")).trim().split("\n").slice(-3).join(" / ").slice(-500);
  return tail ? `${wrong}; stderr ends: ${tail}` : wrong;
}

/** Case `c` prepared in a folder of its own, run, and judged; the folder is removed after. */
async function runCase(
  c: Case,
  command: string[],
  limitMs: number,
): Promise<{ ms: number; wrong?: string | undefined; killed?: boolean }> {
  const dir = await mkdtemp(join(tmpdir(), "darnit-watchdog-"));
  try {
    const input = join(dir, "input");
    await mkdir(input);
    const args = await c.args(input).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
    if (args instanceof Error) return { ms: 0, wrong: `could not be prepared: ${args.message}` };
    const ended = await run([...command, ...args], limitMs, dir);
    return { ms: ended.ms, wrong: await verdict(c, ended, limitMs, dir), killed: ended.killed };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Runs `cases`, `atOnce` at a time, logging each one's time, and returns a line naming each that was killed, ended
 * otherwise than it should, or did not read its input. After a kill no case starts, so a hang everywhere costs one
 * limit, not one per case.
 */
export async function watch(cases: readonly Case[], opts: Options = {}): Promise<string[]> {
  const { limitMs = LIMIT_MS, atOnce = AT_ONCE, command = [process.execPath, CLI], log = console.log } = opts;
  const failures: string[] = [];
  let next = 0;
  let killed: string | undefined;
  const worker = async () => {
    while (next < cases.length && killed === undefined) {
      const c = cases[next++]!;
      const { ms, wrong, killed: stopped } = await runCase(c, command, limitMs);
      log(`${(ms / 1000).toFixed(1).padStart(6)} s  ${c.name}${wrong ? `: ${wrong}` : ""}`);
      if (wrong) failures.push(`${c.name}: ${wrong}`);
      if (stopped) killed ??= c.name;
    }
  };
  await Promise.all(Array.from({ length: atOnce }, worker));
  for (const c of cases.slice(next)) failures.push(`${c.name}: not run, as ${killed} was killed`);
  return failures;
}

/** Why darnit's report does not show it read `file`: it lists it as not checked, or names it among no results. */
export const readIn =
  (file: string) =>
  (out: string): string | undefined => {
    const name = file.replaceAll(".", "\\.");
    if (new RegExp(`^Not checked:.*\\b${name}\\b`, "m").test(out)) return `its output lists ${file} as not checked`;
    return new RegExp(`^  ${name}[: ]`, "m").test(out) ? undefined : `its output names ${file} among no results`;
  };

/** `head`, then `unit` as many times as fit with as many `close` after `middle`, padded with spaces to exactly MAX_FILE_BYTES. */
function sized(head: string, unit: string, close = "", middle = ""): string {
  const n = Math.floor((MAX_FILE_BYTES - head.length - middle.length) / (unit.length + close.length));
  return `${head}${unit.repeat(n)}${middle}${close.repeat(n)}`.padEnd(MAX_FILE_BYTES, " ");
}

/** darnit check on a folder holding one file, `file`, of `text()`, which its report must name. */
const checkOne = (name: string, file: string, text: () => string, code: number): Case => ({
  name: `${file} of ${MAX_FILE_BYTES} bytes holding ${name}`,
  code,
  unread: readIn(file),
  args: async (dir) => {
    await writeFile(join(dir, file), text());
    return ["check", dir];
  },
});

type Language = { head: string; call: string; key: string; end: string };
const JS: Language = {
  head: 'import OpenAI from "openai";\nconst c = new OpenAI();\n',
  call: 'c.chat.completions.create({ model: "gpt-4", max_tokens: 5',
  key: ", x: ",
  end: " })",
};
const PY: Language = {
  head: "from openai import OpenAI\nclient = OpenAI()\n",
  call: 'client.chat.completions.create(model="gpt-4", max_tokens=5',
  key: ", x=",
  end: ")",
};

type Shape = "one line of calls" | "calls nested inside each other" | "a call on every line";
const SHAPES: Record<Shape, (l: Language) => string> = {
  "one line of calls": ({ head, call, end }) => sized(head, `${call}${end}; `),
  "calls nested inside each other": ({ head, call, key, end }) => sized(`${head}x = `, `${call}${key}`, end, "1"),
  "a call on every line": ({ head, call, end }) => sized(head, `${call}${end}\n`),
};

/**
 * Each scanned language in the shapes most likely to be slow. Each reports call sites, so it exits 1. A shape that
 * took within 5% of another of its language, run alone and three at once, is left out.
 */
function codeCases(): Case[] {
  const languages: [string, Language, Shape[]][] = [
    ["app.js", JS, ["one line of calls", "calls nested inside each other"]],
    ["app.ts", JS, ["one line of calls", "calls nested inside each other"]],
    ["app.tsx", JS, ["one line of calls", "calls nested inside each other"]],
    ["app.py", PY, ["calls nested inside each other", "a call on every line"]],
  ];
  return languages.flatMap(([file, language, shapes]) =>
    shapes.map((shape) => checkOne(shape, file, () => SHAPES[shape](language), 1)),
  );
}

/** Files read only for model names, in two shapes for each of six syntaxes. Mentions do not fail the check, so each exits 0. */
function mentionCases(): Case[] {
  return ["main.go", "Main.kt", "Main.java", "main.c", "main.rs", "notes.md"].flatMap((file) => {
    const prose = file.endsWith(".md");
    return [
      checkOne("one line of quoted names", file, () => sized("", prose ? "o1 gpt-4 " : '"o1", "gpt-4", '), 0),
      checkOne("a name on every line", file, () => sized("", prose ? "o1 gpt-4\n" : "// o1 gpt-4\n"), 0),
    ];
  });
}

const diff = (file: string, lines: string[]) =>
  `diff --git a/${file} b/${file}\nindex ${"1".repeat(40)}..${"2".repeat(40)} 100644\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}\n`).join("")}`;

/** As many whole changes as fit under the plan's cap, each with every field at its cap, from another darnit version so none is published. */
function planOf(ids: string[], files: string[], lines: () => string[]): string {
  const outcome = {
    command: "x".repeat(CAPS.command),
    passed: true,
    attributed: null,
    notChecked: false,
    timedOut: false,
    output: "x".repeat(CAPS.output),
  };
  const patch = files.map((f) => diff(f, lines())).join("");
  if (patch.length > CAPS.patch)
    throw new Error(`a patch of ${patch.length} characters is over the cap of ${CAPS.patch}`);
  const groups = ids.slice(0, CAPS.groups).map((id) => ({
    id,
    files,
    patch,
    build: { ...outcome },
    buildNote: null,
    tests: { ...outcome },
    testsNote: null,
  }));
  const text = () => JSON.stringify({ version: 1, darnit: "0.0.0", base: "a".repeat(40), groups });
  let size = Buffer.byteLength(text());
  while (size > CAPS.plan) size -= Buffer.byteLength(JSON.stringify(groups.pop())) + 1;
  return text();
}

const OTHER_VERSION = 'the plan was written by darnit "0.0.0"';

/**
 * fix --publish on large plans it accepts, 86 to 91% of the cap, as the next whole change would pass it. Each was written
 * by another version, so it publishes nothing and exits 1.
 */
async function planCases(): Promise<Case[]> {
  const ids = (await loadRecords()).map((l) => l.record.id);
  const many = Array.from({ length: CAPS.files }, (_, i) => `src/${"d".repeat(150)}/f${i}.js`);
  const plans: [string, () => string][] = [
    ["the most files with the longest patches", () => planOf(ids, many, () => ["x".repeat(200)])],
    ["patches of the most lines", () => planOf(ids, ["app.py"], () => Array<string>(CAPS.patch / 4).fill("x"))],
    [
      "patches of one line as long as the cap allows",
      () => planOf(ids, ["app.py"], () => ["x".repeat(CAPS.patch - 200)]),
    ],
  ];
  return plans.map(([name, plan]) => ({
    name: `a plan of ${name}`,
    code: 1,
    unread: (out) =>
      out.includes(OTHER_VERSION) ? undefined : "its output does not say the plan came from another version",
    args: async (dir) => {
      await mkdir(join(dir, "plan"));
      await writeFile(join(dir, "plan", "plan.json"), plan());
      return ["fix", dir, "--publish", join(dir, "plan"), "--repo", "o/r"];
    },
  }));
}

async function main(): Promise<void> {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing; run npm run build first`);
  const start = Date.now();
  const failures = await watch([...codeCases(), ...mentionCases(), ...(await planCases())]);
  console.log(
    `${((Date.now() - start) / 1000).toFixed(1)} s in all, at most ${AT_ONCE} at once, each killed at ${LIMIT_MS / 1000} s`,
  );
  for (const f of failures) console.error(`::error::${f}`);
  process.exitCode = failures.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
