import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { show } from "./show.js";

// How often each gate is waived: for each line that lets a pull request past a gate, how many merged pull requests
// carry it among those since the gate came in, so a gate people route around gets fixed or removed.
//   tsx scripts/waivers.ts <file> [--from <pr number>]
// <file> is `gh pr list --state merged --limit 1000 --json number,title,body` output. A line counts exactly when the
// gate takes it: the readers below are scripts/pr-common.sh's, and test/waivers.test.ts runs both on the same bodies.

const LINES = [
  // opt_out in scripts/pr-common.sh, read by scripts/check-refactor.sh since #102 and scripts/check-proof.sh since #108.
  { label: "Proof: none", prefix: "Proof: none, ", ciOnly: false, from: 102 },
  // scripts/check-refactor.sh, since #174.
  { label: "Allowlist", prefix: "Allowlist: ", ciOnly: true, from: 174 },
  // scripts/check-coverage.sh, since #176.
  { label: "Coverage", prefix: "Coverage: ", ciOnly: true, from: 176 },
] as const;
type Label = (typeof LINES)[number]["label"];

const PullRequests = z.array(
  z.object({ number: z.number().int().positive(), title: z.string(), body: z.string().nullable() }),
);
type PullRequest = z.infer<typeof PullRequests>[number];

/** `line` without the HTML comments in it, and whether one is still open after it, as the loop in `visible` reads it. */
function uncommented(line: string, open: boolean): [string, boolean] {
  let out = "";
  let at = 0;
  let inside = open;
  while (at < line.length) {
    const i = line.indexOf(inside ? "-->" : "<!--", at);
    if (i < 0) {
      if (!inside) out += line.slice(at);
      break;
    }
    if (!inside) out += line.slice(at, i);
    at = i + (inside ? 3 : 4);
    inside = !inside;
  }
  return [out, inside];
}

/** The body's lines as a reader sees them, as `visible` in scripts/pr-common.sh: HTML comments and fenced code blocks taken out. */
export function visible(body: string): string[] {
  const out: string[] = [];
  let fence = "";
  let inside = false;
  for (const line of body.replaceAll("\r", "").split("\n")) {
    const opened = inside || fence ? undefined : /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opened) fence = opened[1]!;
    else if (fence) {
      const t = line.replace(/^ +/, "");
      if (t.startsWith(fence) && /^(`+|~+)[ \t]*$/.test(t)) fence = "";
    } else {
      const [text, open] = uncommented(line, inside);
      out.push(text);
      inside = open;
    }
  }
  return out;
}

/** The reason on the first line a reader sees that starts with `prefix`, or "" when under 10 characters, as `body_reason`. */
export function bodyReason(body: string, prefix: string): string {
  const line = visible(body).find((l) => l.startsWith(prefix));
  const reason = line?.slice(prefix.length).replace(/[ \t\v\f]+$/, "") ?? "";
  return [...reason].length < 10 ? "" : reason;
}

/** The type in a conventional title, as `title_type`, or "". */
export const titleType = (title: string) => /^([a-z]+)(\([a-z0-9-]+\))?!?: /.exec(title.split("\n")[0]!)?.[1] ?? "";

/** The reason each line gives in this pull request, "" where its gate would not take it. */
export const reasons = (pr: Pick<PullRequest, "title" | "body">) =>
  Object.fromEntries(
    LINES.map((l) => [l.label, l.ciOnly && titleType(pr.title) !== "ci" ? "" : bodyReason(pr.body ?? "", l.prefix)]),
  ) as Record<Label, string>;

type Row = { label: Label; from: number; waived: number; window: number };

export function count(prs: PullRequest[], from = 0): Row[] {
  const given = prs.map((pr) => ({ number: pr.number, reasons: reasons(pr) }));
  return LINES.map((l) => {
    const start = Math.max(l.from, from);
    const window = given.filter((pr) => pr.number >= start);
    return {
      label: l.label,
      from: start,
      waived: window.filter((pr) => pr.reasons[l.label]).length,
      window: window.length,
    };
  });
}

export function table(rows: Row[]): string[] {
  const line = ([first, ...rest]: string[]) =>
    first!.padEnd(12) + rest.map((c, i) => c.padStart([9, 9, 8, 9][i]!)).join("");
  return [
    line(["Line", "Waived", "Merged", "Share", "From"]),
    ...rows.map((r) => {
      const share = r.window ? `${((100 * r.waived) / r.window).toFixed(1)}%` : "-";
      const over = r.waived * 10 > r.window ? "  over 10%" : "";
      return line([r.label, String(r.waived), String(r.window), share, `#${r.from}`]) + over;
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
    seen.add(pr.number);
  }
  return parsed.data;
}

const USAGE = "usage: tsx scripts/waivers.ts <file of gh pr list --json number,title,body> [--from <pr number>]";

function args() {
  const { values, positionals } = parseArgs({ options: { from: { type: "string" } }, allowPositionals: true });
  if (positionals.length !== 1) throw new Error(`expected one file, got ${positionals.length}`);
  if (values.from !== undefined && !/^[1-9]\d*$/.test(values.from))
    throw new Error(`--from takes a pull request number, not ${values.from}`);
  return { file: positionals[0]!, from: Number(values.from ?? 0) };
}

async function main() {
  let file: string, from: number;
  try {
    ({ file, from } = args());
  } catch (err) {
    console.error(`${show(err instanceof Error ? err.message : String(err))}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  try {
    const prs = await load(file);
    console.log([`${prs.length} merged pull requests in ${show(file)}`, ...table(count(prs, from))].join("\n"));
  } catch (err) {
    console.error(`waivers stopped: ${show(err instanceof Error ? err.message : String(err))}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
