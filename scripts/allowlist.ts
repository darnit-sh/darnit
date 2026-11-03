import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Runs knip (unused files, exports and dependencies) or jscpd (duplicated blocks) and compares what it finds with
// scripts/allow/<kind>.tsv, one finding per line with the reason it stays. Fails on a finding the list lacks and on
// a line whose finding is gone, so the list only shrinks.
// Usage: tsx scripts/allowlist.ts unused|duplicates [--root <dir>]

const BIN = fileURLToPath(new URL("../node_modules/.bin/", import.meta.url));
// Tests and data are left out of the duplicate search: tests repeat setup on purpose, so each reads on its own.
const DUPLICATE_PATHS = ["src", "scripts"];
const MIN_TOKENS = "50";

type Line = { line: number; finding: string };
type KnipItem = { name?: unknown } | KnipItem[];
type KnipReport = { issues: ({ file: string } & Record<string, unknown>)[] };
type Place = { name: string; start: number; end: number };
type CloneReport = { duplicates: { firstFile: Place; secondFile: Place }[] };

/** The lines of an allowlist: `fields` tab separated fields that name a finding, then the reason it stays. */
export function parseAllowlist(text: string, fields: number) {
  const lines: Line[] = [];
  const errors: string[] = [];
  const seen = new Map<string, number>();
  text.split("\n").forEach((raw, i) => {
    if (raw.trim() === "" || raw.startsWith("#")) return;
    const parts = raw.split("\t");
    const finding = parts.slice(0, fields).join("\t");
    if (parts.length !== fields + 1 || parts.some((p) => p.trim() === "")) errors.push(`line ${i + 1} needs ${fields} fields and a reason, tab separated`);
    else if (seen.has(finding)) errors.push(`line ${i + 1} repeats line ${seen.get(finding)}`);
    else {
      seen.set(finding, i + 1);
      lines.push({ line: i + 1, finding });
    }
  });
  return { lines, errors };
}

/** Findings the allowlist lacks, and allowlist lines whose finding is gone. */
export function compare(found: readonly string[], lines: readonly Line[]) {
  const listed = new Set(lines.map((l) => l.finding));
  const now = new Set(found);
  return { missing: [...now].filter((f) => !listed.has(f)).sort(), stale: lines.filter((l) => !now.has(l.finding)) };
}

/** Each issue knip reports as `type<TAB>file<TAB>name`; an item without a name is shown whole. */
export function knipFindings(report: KnipReport): string[] {
  const name = (item: KnipItem): string => {
    if (Array.isArray(item)) return item.map(name).join(",");
    return typeof item.name === "string" ? item.name : JSON.stringify(item);
  };
  return report.issues.flatMap(({ file, ...types }) =>
    Object.entries(types)
      .filter(([type, items]) => type !== "owners" && Array.isArray(items))
      .flatMap(([type, items]) => (items as KnipItem[]).map((item) => `${type}\t${file}\t${name(item)}`)),
  );
}

/** Each clone jscpd reports as its two places, `file:start-end`, in order. */
export function cloneFindings(report: CloneReport, root: string): string[] {
  const place = (p: Place) => `${relative(root, p.name)}:${p.start}-${p.end}`;
  return report.duplicates.map((d) => [place(d.firstFile), place(d.secondFile)].sort().join("\t"));
}

function tool(name: string, args: string[], root: string) {
  const r = spawnSync(join(BIN, name), args, { cwd: root, encoding: "utf8", maxBuffer: 2 ** 28, timeout: 300_000 });
  if (r.error) throw new Error(`${name} did not run: ${r.error.message}`);
  return r;
}

function unused(root: string): string[] {
  // Every issue is in the JSON, so the exit code is left for configuration hints and crashes.
  const r = tool("knip", ["--reporter", "json", "--no-progress", "--max-issues", "1000000", "--treat-config-hints-as-errors"], root);
  if (r.status !== 0) throw new Error(`knip exited ${r.status}; run npx knip to see why\n${r.stderr}`);
  return knipFindings(JSON.parse(r.stdout) as KnipReport);
}

function duplicates(root: string): string[] {
  const out = mkdtempSync(join(tmpdir(), "darnit-jscpd-"));
  try {
    const args = ["--min-tokens", MIN_TOKENS, "--ignore-identifiers", "--reporters", "json", "--output", out, "--absolute", "--silent", "--no-tips"];
    const r = tool("jscpd", [...args, ...DUPLICATE_PATHS], root);
    if (r.status !== 0) throw new Error(`jscpd exited ${r.status}\n${r.stderr}`);
    return cloneFindings(JSON.parse(readFileSync(join(out, "jscpd-report.json"), "utf8")) as CloneReport, realpathSync(root));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const KINDS = { unused: { find: unused, fields: 3 }, duplicates: { find: duplicates, fields: 2 } };

/** The problems with `root`'s allowlist for `kind`, one message each. */
export function check(kind: keyof typeof KINDS, root: string): string[] {
  const file = `scripts/allow/${kind}.tsv`;
  const { lines, errors } = parseAllowlist(readFileSync(join(root, file), "utf8"), KINDS[kind].fields);
  const { missing, stale } = compare(KINDS[kind].find(root), lines);
  return [
    ...errors.map((e) => `${file}: ${e}`),
    ...missing.map((f) => `not in ${file}: ${f} (remove it, or add the line with the reason it stays)`),
    ...stale.map((s) => `${file}:${s.line} is no longer found: ${s.finding} (remove the line)`),
  ];
}

function main() {
  const kind = process.argv[2];
  const at = process.argv.indexOf("--root");
  const root = at > 0 ? resolve(process.argv[at + 1] ?? "") : fileURLToPath(new URL("../", import.meta.url));
  if (kind !== "unused" && kind !== "duplicates") {
    console.error("usage: tsx scripts/allowlist.ts unused|duplicates [--root <dir>]");
    process.exitCode = 2;
    return;
  }
  const problems = check(kind, root);
  for (const p of problems) console.error(p);
  if (problems.length > 0) process.exitCode = 1;
  else console.log(`${kind}: every finding is in scripts/allow/${kind}.tsv`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
