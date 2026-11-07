// Lists everything in a packed tarball that should not ship: a path outside package.json's "files" or on the deny
// list, an entry that is not a plain file, a record that differs from or is missing against packs/, a wrong version
// or bin, or more than MAX_UNPACKED bytes unpacked. Reads the tar itself rather than through the system tar, whose
// listing differs between GNU and BSD tar and cannot be parsed safely: each entry's type comes from its header.
//   tsx scripts/check-package.ts <file.tgz> [--version <v>]   exit 0 clean, 1 findings, 2 bad usage or unreadable
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

export const MAX_UNPACKED = 1_000_000;
// Room for tar headers and padding; past these the tarball is not read further and that is a finding.
export const MAX_READ = 8 * MAX_UNPACKED;
const MAX_ENTRIES = 5_000;
const ROOT = resolve(import.meta.dirname, "..");
// npm ships these whatever "files" says.
const ALWAYS = ["package.json", "README*", "LICENSE*"];
const DENY: [RegExp, string][] = [
  [/(^|\/)\./, "a dotfile or dot folder"],
  [/(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/i, "a test file"],
  [/\.map$/i, "a source map"],
  [/(^|[/.])env(\.[^/]*)?$/i, "an env file"],
  [/\.(pem|key|p12|pfx|jks|keystore|ppk|gpg|asc)$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)/i, "named like a key"],
  [/(^|[/._-])(secrets?|credentials?|private[-_]?key)([._-][^/]*)?$/i, "named like a key"],
];
// What each tar entry type from 1 to 6 is; only 0, a plain file, ships.
const TYPES = ["", "a hard link", "a symlink", "a device", "a device", "a folder", "a pipe"];
const USAGE = "usage: tsx scripts/check-package.ts <file.tgz> [--version <v>]";

// Entries that describe the next one: pax extended and global headers, GNU long names and long link names.
const META = "xgLK";

type Manifest = { version?: string; bin?: Record<string, string> };
type Entry = { path: string; type: string; size: number; data: Buffer; link: string };

const text = (b: Buffer, from: number, len: number) => {
  const s = b.subarray(from, from + len);
  const nul = s.indexOf(0);
  return (nul < 0 ? s : s.subarray(0, nul)).toString("utf8");
};
const octal = (b: Buffer, from: number, len: number) => {
  const s = text(b, from, len).trim();
  if (!/^[0-7]*$/.test(s)) throw new Error(`a tar header field is not octal: ${JSON.stringify(s)}`);
  return parseInt(s || "0", 8);
};
const checksum = (h: Buffer) => h.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);

function pax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (let at = 0; at < data.length;) {
    const space = data.indexOf(0x20, at);
    const len = Number(data.toString("utf8", at, space));
    if (space < 0 || !Number.isInteger(len) || len <= 0 || at + len > data.length)
      throw new Error("unreadable pax header");
    const record = data.toString("utf8", space + 1, at + len - 1);
    out[record.slice(0, record.indexOf("="))] = record.slice(record.indexOf("=") + 1);
    at += len;
  }
  return out;
}

// One header and its data. Pax and GNU long name entries carry the path, link or size of the entry after them.
function entry(tar: Buffer, at: number, ext: Record<string, string>): Entry {
  const h = tar.subarray(at, at + 512);
  if (checksum(h) !== octal(h, 148, 8)) throw new Error(`bad tar header checksum at byte ${at}`);
  const type = String.fromCharCode(h[156] || 48);
  const own = META.includes(type) ? {} : ext;
  const size = own.size === undefined ? octal(h, 124, 12) : Number(own.size);
  const data = tar.subarray(at + 512, at + 512 + size);
  if (!Number.isSafeInteger(size) || data.length < size) throw new Error(`tar entry at byte ${at} is cut short`);
  const prefix = h.toString("latin1", 257, 263) === "ustar\0" ? text(h, 345, 155) : "";
  const name = prefix ? `${prefix}/${text(h, 0, 100)}` : text(h, 0, 100);
  return { path: own.path ?? name, type, size, data, link: own.linkpath ?? text(h, 157, 100) };
}

function readTar(tar: Buffer): { entries: Entry[]; findings: string[] } {
  const entries: Entry[] = [];
  let ext: Record<string, string> = {};
  for (let at = 0; at + 512 <= tar.length && tar.subarray(at, at + 512).some((b) => b !== 0);) {
    const e = entry(tar, at, ext);
    at += 512 + Math.ceil(e.size / 512) * 512;
    if (e.type === "x") ext = { ...ext, ...pax(e.data) };
    else if (e.type === "L") ext = { ...ext, path: text(e.data, 0, e.size) };
    else if (e.type === "K") ext = { ...ext, linkpath: text(e.data, 0, e.size) };
    else {
      entries.push(e);
      ext = {};
      if (entries.length >= MAX_ENTRIES)
        return { entries, findings: [`${MAX_ENTRIES} entries or more; read stopped there`] };
    }
  }
  return { entries, findings: [] };
}

// A "files" entry as a pattern: ** spans folders, * stays within one, and a plain name includes what is under it.
const GLOB: Record<string, string> = { "**/": "(.*/)?", "/**": "/.*", "**": ".*", "*": "[^/]*" };
const glob = (p: string) => {
  const re = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/|\/\*\*$|\*\*|\*/g, (m) => GLOB[m]!);
  return new RegExp(`^${re}${p.includes("*") ? "" : "(/.*)?"}$`);
};

function rules(root: string) {
  const { files = [] } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files?: string[] };
  const keep = [...ALWAYS, ...files.filter((f) => !f.startsWith("!"))].map(glob);
  const drop = files.filter((f) => f.startsWith("!")).map((f) => glob(f.slice(1)));
  const denied = (p: string) => DENY.find(([re]) => re.test(p))?.[1];
  const allowed = (p: string) => keep.some((re) => re.test(p)) && !drop.some((re) => re.test(p));
  return { denied, allowed };
}

function pathFinding(e: Entry, { denied, allowed }: ReturnType<typeof rules>): string | undefined {
  if (e.type !== "0")
    return `${e.path}: ${TYPES[parseInt(e.type)] || `tar entry type ${JSON.stringify(e.type)}`}${e.link && ` to ${e.link}`}`;
  const rel = e.path.slice("package/".length);
  if (!e.path.startsWith("package/") || e.path.includes("\\") || e.path.split("/").includes(".."))
    return `${e.path}: outside package/`;
  const deny = denied(rel);
  if (deny) return `${e.path}: ${deny}`;
  return allowed(rel) ? undefined : `${e.path}: not in package.json "files"`;
}

// Every record file in the tarball matches the checkout's copy, and every one the checkout would ship is there.
function recordFindings(files: Map<string, Entry>, root: string, r: ReturnType<typeof rules>): string[] {
  const out: string[] = [];
  for (const [path, e] of files) {
    if (!path.startsWith("package/packs/")) continue;
    const local = join(root, path.slice("package/".length));
    if (!statSync(local, { throwIfNoEntry: false })?.isFile() || !readFileSync(local).equals(e.data))
      out.push(`${path}: differs from ${relative(root, local)} in the checkout`);
  }
  for (const d of readdirSync(join(root, "packs"), { recursive: true, withFileTypes: true })) {
    const rel = relative(root, join(d.parentPath, d.name)).split("\\").join("/");
    if (d.isFile() && r.allowed(rel) && !r.denied(rel) && !files.has(`package/${rel}`))
      out.push(`${rel}: in the checkout but not in the tarball`);
  }
  return out;
}

function manifestFindings(files: Map<string, Entry>, version: string | undefined): string[] {
  const manifest = files.get("package/package.json");
  if (!manifest) return ["package/package.json: missing"];
  const pkg = JSON.parse(manifest.data.toString("utf8")) as Manifest;
  const out = Object.values(pkg.bin ?? {})
    .filter((target) => !files.has(posix.join("package", target)))
    .map((target) => `package/package.json: bin ${target} is not in the tarball`);
  if (version !== undefined && pkg.version !== version)
    out.push(`package/package.json: version ${pkg.version}, expected ${version}`);
  return out;
}

export function checkPackage(
  file: string,
  { root = ROOT, version }: { root?: string; version?: string | undefined } = {},
): string[] {
  const size = statSync(file).size;
  if (size > MAX_READ) return [`${file}: ${size} bytes, more than ${MAX_READ} to read`];
  let tar: Buffer;
  try {
    tar = gunzipSync(readFileSync(file), { maxOutputLength: MAX_READ });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE")
      return [`${file}: unpacks to more than ${MAX_READ} bytes`];
    throw new Error(`${file}: ${(e as Error).message}`, { cause: e });
  }
  const { entries, findings } = readTar(tar);
  const r = rules(root);
  const files = new Map(entries.filter((e) => !pathFinding(e, r)).map((e) => [e.path, e]));
  const unpacked = entries.reduce((sum, e) => sum + e.size, 0);
  if (unpacked > MAX_UNPACKED) findings.push(`unpacks to ${unpacked} bytes, more than ${MAX_UNPACKED}`);
  return [
    ...entries.map((e) => pathFinding(e, r)).filter((f) => f !== undefined),
    ...recordFindings(files, root, r),
    ...manifestFindings(files, version),
    ...findings,
  ];
}

function main(args: string[]): number {
  try {
    const { positionals, values } = parseArgs({
      args,
      options: { version: { type: "string" } },
      allowPositionals: true,
    });
    if (positionals.length !== 1 || values.version === "") throw new Error("expected one tarball");
    const file = resolve(process.env.INIT_CWD || process.cwd(), positionals[0]!);
    const findings = checkPackage(file, { version: values.version });
    for (const f of findings) console.log(f);
    console.log(findings.length ? `${findings.length} found in ${file}` : `${file}: nothing that should not ship`);
    return findings.length ? 1 : 0;
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = main(process.argv.slice(2));
