import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stillUnused } from "./unseen.js";

// Runs knip (unused files, exports and dependencies) or jscpd (duplicated blocks) and compares what it finds with
// scripts/allow/<kind>.tsv, one finding per line with the reason it stays. Fails on a finding the list lacks and on
// a line whose finding is gone, so the list only shrinks. Neither tool reads git's ignore files, and jscpd gets an
// empty config in place of a .jscpd.json, so a local run finds what CI finds. knip reads a "knip" key in package.json
// whatever --config says, so the check refuses to run with one, or with a "jscpd" key.
// Usage: tsx scripts/allowlist.ts unused|duplicates [--root <dir>]

// Tests and data are left out of the duplicate search: tests repeat setup on purpose, so each reads on its own.
const DUPLICATE_PATHS = ["src", "scripts"];
const MIN_TOKENS = "50";
// An `unseen` line in unused.tsv names code knip cannot see is unused, judged by scripts/unseen.ts instead.
const UNSEEN = "unseen";

type Line = { line: number; finding: string };
/** What a tool found, each finding with a note shown beside it when the list lacks it. */
type Found = ReadonlyMap<string, string>;
type KnipItem = { name?: unknown; namespace?: unknown } | KnipItem[];
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
export function compare(found: Iterable<string>, lines: readonly Line[]) {
  const listed = new Set(lines.map((l) => l.finding));
  const now = new Set(found);
  return { missing: [...now].filter((f) => !listed.has(f)).sort(), stale: lines.filter((l) => !now.has(l.finding)) };
}

/** What is wrong with the allowlist `file` holds as `text`, given what a tool found, one message each. */
export function problems(file: string, text: string, fields: number, find: (lines: readonly Line[]) => Found | readonly string[]): string[] {
  const { lines, errors } = parseAllowlist(text, fields);
  const result = find(lines);
  const found: Found = Array.isArray(result) ? new Map(result.map((f) => [f, ""])) : (result as Found);
  const { missing, stale } = compare(found.keys(), lines);
  const note = (f: string) => (found.get(f) ? ` (${found.get(f)})` : "");
  return [
    ...errors.map((e) => `${file}: ${e}`),
    ...missing.map((f) => `not in ${file}: ${f}${note(f)}; remove it, or add the line with the reason it stays`),
    ...stale.map((s) => `${file}:${s.line} is no longer found: ${s.finding}; remove the line`),
  ];
}

/** Each issue knip reports as `type<TAB>file<TAB>name`, a member as `parent.name`; an item without a name is shown whole. */
export function knipFindings(report: KnipReport): string[] {
  const name = (item: KnipItem): string => {
    if (Array.isArray(item)) return item.map(name).join(",");
    if (typeof item.name !== "string") return JSON.stringify(item);
    return typeof item.namespace === "string" ? `${item.namespace}.${item.name}` : item.name;
  };
  return report.issues.flatMap(({ file, ...types }) =>
    Object.entries(types)
      .filter(([type, items]) => type !== "owners" && Array.isArray(items))
      .flatMap(([type, items]) => (items as KnipItem[]).map((item) => `${type}\t${file}\t${name(item)}`)),
  );
}

/**
 * Each clone jscpd reports, keyed by its two files and its place among the clones between them (`#1`, `#2`), so an
 * edit to a listed block, or anywhere else in either file, keeps the key; a new clone between the same files is one
 * more. The note gives the lines.
 */
export function cloneFindings(report: CloneReport, root: string): Found {
  const pairs = new Map<string, string[]>();
  for (const d of report.duplicates) {
    const sides = [d.firstFile, d.secondFile].map((p) => ({ file: relative(root, p.name), at: `${relative(root, p.name)}:${p.start}-${p.end}` }));
    sides.sort((a, b) => a.file.localeCompare(b.file) || a.at.localeCompare(b.at, undefined, { numeric: true }));
    const key = sides.map((s) => s.file).join("\t");
    pairs.set(key, [...(pairs.get(key) ?? []), sides.map((s) => s.at).join(" and ")]);
  }
  const found = new Map<string, string>();
  for (const [key, places] of pairs) places.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).forEach((at, i) => found.set(`${key}\t#${i + 1}`, `lines ${at}`));
  return found;
}

/** The `unseen` lines whose name is still unused, by scripts/unseen.ts. */
function unseen(root: string, lines: readonly Line[]): string[] {
  const listed = lines.map((l) => l.finding.split("\t")).filter(([type]) => type === UNSEEN);
  const files = new Set(listed.map(([, file]) => file!));
  return [...files].flatMap((file) => [...stillUnused(root, file, listed.filter(([, f]) => f === file).map(([, , n]) => n!))].map((n) => `${UNSEEN}\t${file}\t${n}`));
}

function tool(name: string, args: string[], root: string) {
  const r = spawnSync(join(root, "node_modules", ".bin", name), args, { cwd: root, encoding: "utf8", maxBuffer: 2 ** 28, timeout: 300_000 });
  if (r.error) throw new Error(`${name} did not run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${name} exited ${r.status}; run npx ${name} to see why\n${r.stderr}`);
  return r.stdout;
}

function unused(root: string, lines: readonly Line[]): string[] {
  // Every issue is in the JSON, so the exit code is left for configuration hints and crashes. The build config maps
  // package.json's bin in dist/ back to src/, which knip needs once it reads no ignore files.
  const args = ["--reporter", "json", "--no-progress", "--no-gitignore", "--tsConfig", "tsconfig.build.json"];
  const out = tool("knip", [...args, "--max-issues", "1000000", "--treat-config-hints-as-errors"], root);
  return [...knipFindings(JSON.parse(out) as KnipReport), ...unseen(root, lines)];
}

function duplicates(root: string): Found {
  const out = mkdtempSync(join(tmpdir(), "darnit-jscpd-"));
  try {
    // An empty config in place of a .jscpd.json the folder might hold.
    writeFileSync(join(out, "config.json"), "{}\n");
    const args = ["--config", join(out, "config.json"), "--no-gitignore", "--min-tokens", MIN_TOKENS, "--ignore-identifiers"];
    tool("jscpd", [...args, "--reporters", "json", "--output", out, "--absolute", "--silent", "--no-tips", ...DUPLICATE_PATHS], root);
    return cloneFindings(JSON.parse(readFileSync(join(out, "jscpd-report.json"), "utf8")) as CloneReport, realpathSync(root));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const KINDS = { unused: { find: unused, fields: 3 }, duplicates: { find: duplicates, fields: 3 } };

/** The problems with `root`'s allowlist for `kind`, one message each. It is read only as a file at its own path. */
export function check(kind: keyof typeof KINDS, root: string): string[] {
  const file = `scripts/allow/${kind}.tsv`;
  const at = join(root, file);
  if (realpathSync(at) !== join(realpathSync(root), file) || !lstatSync(at).isFile()) return [`${file} is reached through a link or is not a file; it is read only as a file at that path`];
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as object;
  const keys = ["knip", "jscpd"].filter((k) => Object.hasOwn(pkg, k));
  if (keys.length > 0) return keys.map((k) => `package.json has a "${k}" key, which would add to what knip.json and this check set; remove it`);
  return problems(file, readFileSync(at, "utf8"), KINDS[kind].fields, (lines) => KINDS[kind].find(root, lines));
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
  const found = check(kind, root);
  for (const p of found) console.error(p);
  if (found.length > 0) process.exitCode = 1;
  else console.log(`${kind}: every finding is in scripts/allow/${kind}.tsv`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
