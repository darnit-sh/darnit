import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { show } from "./show.js";

// How often each gate is waived, so a gate people route around gets fixed or removed. Per line that lets a pull
// request past a gate: how many merged pull requests hold one the gate would accept, among those of the title types
// the gate reads it for, merged after the pull request that added the gate (pr.yml runs base's copy of each gate).
//   gh pr list --state merged --limit 1000 --json number,title,body,mergedAt > prs.json
//   tsx scripts/waivers.ts prs.json [--from <number of a merged pull request in the file>]
// --from starts every window after that pull request merged, where it merged later than the gate's. A pull request
// merged in the same second as the one a window starts after is left out, as gh gives merge times to the second.
// Each body is read by scripts/pr-common.sh itself, in the locale of the gates' ubuntu runner. It does not read
// which files a pull request changed, and a gate reads its line only when it finds something to waive, so a count
// is of pull requests that hold the line, not of pull requests a gate let through on it.

type Key = "proof" | "allowlist" | "coverage";
const ROWS: { line: string; key: Key; since: Record<string, number> }[] = [
  // refactor and perf: scripts/check-refactor.sh since #102; fix and feat: scripts/check-proof.sh since #108.
  { line: "Proof: none", key: "proof", since: { fix: 108, feat: 108, refactor: 102, perf: 102 } },
  // test and ci when they change the suite: scripts/check-refactor.sh since #137. CONTRIBUTING asks a ci change
  // that changes how the checks run for one, so this row is mostly paperwork, not a gate routed around.
  { line: "Proof: none", key: "proof", since: { test: 137, ci: 137 } },
  // scripts/check-refactor.sh, since #174.
  { line: "Allowlist", key: "allowlist", since: { ci: 174 } },
  // scripts/check-coverage.sh, since #176.
  { line: "Coverage", key: "coverage", since: { ci: 176 } },
];

const PullRequests = z.array(
  z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable(),
    mergedAt: z.iso.datetime(),
  }),
);
type PullRequest = z.infer<typeof PullRequests>[number];
export type Read = { type: string } & Record<Key, string>;

// The gates' own calls. The body comes on stdin, where no limit on the size of an environment variable applies;
// $(cat) drops only trailing newlines, which change no line a reader sees.
const READ = `BODY=$(cat); . "$COMMON"
t=$(title_type); opt_out >/dev/null; p=$reason
body_reason "Allowlist: " Allowlist >/dev/null; a=$reason
body_reason "Coverage: " Coverage >/dev/null; c=$reason
printf '%s\\0' "$t" "$p" "$a" "$c"`;

/** The title's type and each line's reason as the gates read them, "" where a gate would not take the line. */
export function read(title: string, body: string): Promise<Read> {
  const env = {
    PATH: process.env.PATH ?? "",
    LC_ALL: "C.UTF-8",
    TITLE: title,
    COMMON: fileURLToPath(new URL("pr-common.sh", import.meta.url)),
    GITHUB_STEP_SUMMARY: "/dev/null",
  };
  return new Promise((done, fail) => {
    const child = spawn("sh", ["-c", READ], { env, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stdin.on("error", () => {}).end(body);
    child.on("error", fail).on("close", (status) => {
      const [type, proof, allowlist, coverage] = out.split("\0");
      if (status === 0 && coverage !== undefined) done({ type: type!, proof: proof!, allowlist: allowlist!, coverage });
      else fail(new Error(`scripts/pr-common.sh exited ${status} on a body`));
    });
  });
}

async function readAll(prs: PullRequest[]): Promise<Read[]> {
  const out: Read[] = [];
  let next = 0;
  const worker = async () => {
    while (next < prs.length) {
      const i = next++;
      out[i] = await read(prs[i]!.title, prs[i]!.body ?? "");
    }
  };
  await Promise.all(Array.from({ length: availableParallelism() }, worker));
  return out;
}

type Row = { line: string; types: string[]; after: number[]; counts?: { waived: number; window: number } };

/** Why `n` cannot start a window, or undefined when the file holds it. */
export function absent(prs: PullRequest[], n: number): string | undefined {
  if (prs.some((pr) => pr.number === n)) return undefined;
  const lowest = Math.min(...prs.map((pr) => pr.number));
  const more = n < lowest ? `, whose lowest is #${lowest}: fetch with --limit 1000` : "";
  return `#${n} is not a merged pull request in the file${more}`;
}

/** Each row's window and count, and a warning for each gate's pull request the file lacks. `from` is in the file. */
export function count(prs: PullRequest[], reads: Read[], from?: number) {
  const merged = new Map(prs.map((pr) => [pr.number, Date.parse(pr.mergedAt)]));
  const warnings = new Set<string>();
  const rows: Row[] = ROWS.map(({ line, key, since }) => {
    const starts = Object.entries(since).map(([type, gate]) => {
      const later = from !== undefined && merged.get(from)! > (merged.get(gate) ?? -Infinity);
      return [type, later ? from : gate] as const;
    });
    const after = [...new Set(starts.map(([, n]) => n))].sort((a, b) => a - b);
    const why = Object.values(since).flatMap((n) => absent(prs, n) ?? []);
    for (const w of why) warnings.add(w);
    if (why.length) return { line, types: Object.keys(since), after };
    const start = new Map(starts.map(([type, n]) => [type, merged.get(n)!]));
    const window = prs
      .map((pr, i) => [pr, reads[i]!] as const)
      .filter(([pr, r]) => (start.get(r.type) ?? Infinity) < Date.parse(pr.mergedAt));
    const waived = window.filter(([, r]) => r[key]).length;
    return { line, types: Object.keys(since), after, counts: { waived, window: window.length } };
  });
  return { rows, warnings: [...warnings] };
}

export function table(rows: Row[]): string[] {
  const line = (cells: string[]) =>
    cells[0]!.padEnd(13) +
    cells[1]!.padEnd(24) +
    cells
      .slice(2, 5)
      .map((c) => c.padStart(8))
      .join("") +
    cells[5];
  return [
    line(["Line", "Title types", "Waived", "Merged", "Share", "  After"]),
    ...rows.map(({ line: name, types, after, counts }) => {
      const share = counts?.window ? `${((100 * counts.waived) / counts.window).toFixed(1)}%` : "-";
      const over = counts && counts.waived * 10 > counts.window ? "  over 10%" : "";
      const cells = [String(counts?.waived ?? "-"), String(counts?.window ?? "-"), share];
      return line([name, types.join(" "), ...cells, `  ${after.map((n) => `#${n}`).join(" ")}${over}`]);
    }),
  ];
}

/** Reads the file, or throws with what is wrong with it. */
async function load(file: string): Promise<PullRequest[]> {
  const parsed = PullRequests.safeParse(JSON.parse(await readFile(file, "utf8")));
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`${issue.path.length ? `entry ${issue.path.join(".")}` : "the file"}: ${issue.message}`);
  }
  const seen = new Set<number>();
  for (const pr of parsed.data) {
    if (seen.has(pr.number)) throw new Error(`pull request #${pr.number} is listed twice`);
    if (pr.body?.includes("\0"))
      throw new Error(`pull request #${pr.number} has a NUL in its body, which no gate reads`);
    seen.add(pr.number);
  }
  if (!seen.size) throw new Error("the file lists no pull requests");
  return parsed.data;
}

const USAGE =
  "usage: gh pr list --state merged --limit 1000 --json number,title,body,mergedAt > prs.json\n       tsx scripts/waivers.ts prs.json [--from <number of a merged pull request in the file>]";
const COUNTS =
  "Counts merged pull requests whose body holds a line the gate would accept, of the title types it reads the line for, merged after the pull request named under After. It does not read which files each changed, so it does not count pull requests a gate let through on the line.";
// A reason ending in U+3000: the runner's sed cuts it under C.UTF-8, which leaves it too short.
const PROBE = ["fix: x", "Proof: none, abcdefghi\u3000"] as const;
const DIFFERS =
  "note: this machine's shell tools keep a trailing Unicode space, such as U+3000, that the gates' ubuntu runner cuts under C.UTF-8. macOS has no C.UTF-8 locale, so this note shows on every run there. A reason ending in such a space can count here and not in the gate.";

function args() {
  const { values, positionals } = parseArgs({ options: { from: { type: "string" } }, allowPositionals: true });
  if (positionals.length !== 1) throw new Error(`expected one file, got ${positionals.length}`);
  if (values.from !== undefined && !/^[1-9]\d*$/.test(values.from))
    throw new Error(`--from takes a pull request number, not ${values.from}`);
  return { file: positionals[0]!, from: values.from === undefined ? undefined : Number(values.from) };
}

async function main() {
  let file: string, from: number | undefined;
  try {
    ({ file, from } = args());
  } catch (err) {
    console.error(`${show(err instanceof Error ? err.message : String(err))}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  try {
    const prs = await load(file);
    const unknown = from === undefined ? undefined : absent(prs, from);
    if (unknown) throw new Error(`--from ${unknown}`);
    const { rows, warnings } = count(prs, await readAll(prs), from);
    const probe = (await read(...PROBE)).proof ? [DIFFERS] : [];
    const head = [`${prs.length} merged pull requests in ${show(file)}.`, COUNTS];
    console.log([...head, ...probe, ...warnings.map((w) => `warning: ${w}`), ...table(rows)].join("\n"));
  } catch (err) {
    console.error(`waivers stopped: ${show(err instanceof Error ? err.message : String(err))}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
