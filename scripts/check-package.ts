// Lists everything in a packed tarball that should not ship: a path outside package.json's "files" or on the deny
// list, an entry that is not a plain file, a package.json or record that differs from the checkout's or is missing,
// a wrong version or bin, or more than MAX_UNPACKED bytes unpacked. The tarball is read twice: by the strict reader
// below, which refuses anything it cannot explain, and by the tar reader inside npm, which installs the package.
// The two listings must agree entry for entry, so a header the two read apart is refused, not passed.
//   tsx scripts/check-package.ts <file.tgz> [--version <v>]   exit 0 clean, 1 findings, 2 bad usage or unreadable
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

export const MAX_UNPACKED = 1_000_000;
// Read budgets: past any of them the tarball is refused unread (exit 2).
export const MAX_READ = 8 * MAX_UNPACKED;
const MAX_ENTRIES = 5_000;
// Pax and long name headers in a row before one entry; npm writes at most one.
const MAX_META = 4;
// Tar magic and version whose prefix field is part of the path (POSIX ustar), and GNU's, which has no prefix.
export const PREFIXED = new Set(["ustar\u000000"]);
const GNU = "ustar  \u0000";
const ROOT = resolve(import.meta.dirname, "..");
// npm ships these whatever "files" says.
const ALWAYS = ["package.json", "README*", "LICENSE*"];
const DENY: [RegExp, string][] = [
  [/(^|\/)\./, "a dotfile or dot folder"],
  [/(^|\/)(tests?|__tests__)\/|(^|[/.])(test|spec)\.[cm]?[jt]sx?$/i, "a test file"],
  [/\.map$/i, "a source map"],
  [/(^|[/.])env(\.[^/]*)?$/i, "an env file"],
  [/\.(pem|key|crt|cer|der|p8|p12|pfx|jks|keystore|ppk|gpg|asc)$/i, "named like a key"],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)/i, "named like a key"],
  [/(^|[/._-])(secrets?|credentials?|private[-_]?key)([._-][^/]*)?$/i, "named like a key"],
];
// npm pack writes a file's own mode with owner read and write added and group and other write removed: 0644, or
// 0755 for an executable. It keeps setuid, setgid and sticky, which npm installs as they are; no package needs them.
const SPECIAL = { setuid: 0o4000, setgid: 0o2000, sticky: 0o1000 };
// What each tar entry type from 1 to 6 is; only 0, a plain file, ships.
const TYPES = ["", "a hard link", "a symlink", "a device", "a device", "a folder", "a pipe"];
const USAGE = "usage: tsx scripts/check-package.ts <file.tgz> [--version <v>]";

type Manifest = { version?: string; bin?: Record<string, string> };
type Entry = { path: string; type: string; size: number; mode: number; data: Buffer; link: string };
type Rules = { denied: (p: string) => string | undefined; allowed: (p: string) => boolean };
type NpmEntry = { path: string; size: number; mode?: number; header: { typeKey: string }; resume(): void };
type NpmParser = { on(event: string, f: (e: NpmEntry) => void): void; end(data: Buffer): void };

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
const zero = (b: Buffer) => b.every((byte) => byte === 0);

// Each record is "<length> <key>=<value>\n", the length in bytes and counting itself. A value holding a NUL or a
// newline is refused: npm's reader cuts a path at a NUL and splits records at newlines, so either could hide a path.
function pax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (let at = 0; at < data.length;) {
    const space = data.indexOf(0x20, at);
    const digits = data.toString("latin1", at, space);
    const end = at + Number(digits);
    const record = data.toString("utf8", space + 1, end - 1);
    const eq = record.indexOf("=");
    if (!/^\d+$/.test(digits) || data[end - 1] !== 0x0a || eq < 1) throw new Error("unreadable pax header");
    if (/[\0\n]/.test(record)) throw new Error(`a pax record holds a NUL or newline: ${JSON.stringify(record)}`);
    out[record.slice(0, eq)] = record.slice(eq + 1);
    at = end;
  }
  return out;
}

function header(tar: Buffer, at: number) {
  const h = tar.subarray(at, at + 512);
  if (checksum(h) !== octal(h, 148, 8)) throw new Error(`bad tar header checksum at byte ${at}`);
  const magic = h.toString("latin1", 257, 265);
  if (!PREFIXED.has(magic) && magic !== GNU)
    throw new Error(`unknown tar magic ${JSON.stringify(magic)} at byte ${at}`);
  const prefix = PREFIXED.has(magic) ? text(h, 345, 155) : "";
  const name = text(h, 0, 100);
  return {
    type: String.fromCharCode(h[156] || 48),
    size: octal(h, 124, 12),
    mode: octal(h, 100, 8),
    name: prefix ? `${prefix}/${name}` : name,
  };
}

// One header and its data, with what the pax and long name headers before it set.
function entry(tar: Buffer, at: number, ext: Record<string, string>): Entry {
  const { type, size, mode, name } = header(tar, at);
  if (ext.size !== undefined && ext.size !== String(size)) throw new Error(`a pax size differs at byte ${at}`);
  const data = tar.subarray(at + 512, at + 512 + size);
  if (data.length < size) throw new Error(`tar entry at byte ${at} is cut short`);
  return { path: ext.path ?? name, type, size, mode, data, link: ext.linkpath ?? text(tar, at + 157, 100) };
}

function readTar(tar: Buffer): Entry[] {
  const entries: Entry[] = [];
  let ext: Record<string, string> = {};
  let meta = 0;
  for (let at = 0; at < tar.length;) {
    if (zero(tar.subarray(at, at + 512))) {
      if (!zero(tar.subarray(at))) throw new Error(`data after a zero block at byte ${at}`);
      break;
    }
    const e = entry(tar, at, ext);
    at += 512 + Math.ceil(e.size / 512) * 512;
    if (e.type === "x" || e.type === "L") {
      if (++meta > MAX_META) throw new Error(`more than ${MAX_META} pax or long name headers in a row`);
      Object.assign(ext, e.type === "x" ? pax(e.data) : { path: text(e.data, 0, e.size) });
      continue;
    }
    entries.push(e);
    [ext, meta] = [{}, 0];
    if (entries.length > MAX_ENTRIES) throw new Error(`more than ${MAX_ENTRIES} entries`);
  }
  return entries;
}

// The same tarball through the tar reader inside the npm on PATH, as path, type code, size and mode per entry.
// It trusts the job's PATH to find npm, as the rest of the publish pipeline does.
function npmListing(tar: Buffer): string[] {
  const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  let Parser: new (o: { strict: boolean }) => NpmParser;
  try {
    ({ Parser } = createRequire(join(root, "npm", "node_modules", "_.js"))("tar") as { Parser: typeof Parser });
  } catch (e) {
    throw new Error(`npm's tar reader is not under ${root}`, { cause: e });
  }
  const out: string[] = [];
  const parser = new Parser({ strict: true });
  parser.on("entry", (e) => {
    out.push(`${e.path} ${e.header.typeKey} ${e.size} ${e.mode?.toString(8)}`);
    e.resume();
  });
  parser.on("ignoredEntry", (e) => out.push(`${e.path} ignored`));
  try {
    parser.end(tar);
  } catch (e) {
    throw new Error(`npm's tar reader: ${(e as Error).message}`, { cause: e });
  }
  return out;
}

function listingFindings(entries: Entry[], tar: Buffer): string[] {
  const ours = entries.map((e) => `${e.path} ${e.type} ${e.size} ${e.mode.toString(8)}`);
  const npm = npmListing(tar);
  const at = Array.from({ length: Math.max(ours.length, npm.length) }, (_, n) => n).find((n) => ours[n] !== npm[n]);
  if (at === undefined) return [];
  return [`npm's tar reads entry ${at + 1} as ${npm[at] ?? "nothing"}, this script as ${ours[at] ?? "nothing"}`];
}

const GLOB: Record<string, string> = { "**/": "(.*/)?", "/**": "/.*", "**": ".*", "*": "[^/]*" };
const glob = (p: string) => {
  const re = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/|\/\*\*$|\*\*|\*/g, (m) => GLOB[m]!);
  return new RegExp(`^${re}${p.includes("*") ? "" : "(/.*)?"}$`);
};

function rules(root: string): Rules {
  const { files = [] } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files?: string[] };
  const keep = [...ALWAYS, ...files.filter((f) => !f.startsWith("!"))].map(glob);
  const drop = files.filter((f) => f.startsWith("!")).map((f) => glob(f.slice(1)));
  const denied = (p: string) => DENY.find(([re]) => re.test(p))?.[1];
  const allowed = (p: string) => keep.some((re) => re.test(p)) && !drop.some((re) => re.test(p));
  return { denied, allowed };
}

const escapes = (p: string) => !p.startsWith("package/") || p.includes("\\") || p.split("/").includes("..");
// The nearest folder of a path that the tarball also holds as a file.
const fileParent = (p: string, shipped: Set<string>) =>
  [...p.matchAll(/\//g)].map((m) => p.slice(0, m.index)).find((parent) => shipped.has(parent));

function modeFinding({ path, mode }: Entry): string | undefined {
  if ((mode & ~0o755) === 0 && (mode & 0o600) === 0o600) return undefined;
  const special = Object.entries(SPECIAL).flatMap(([name, bit]) => (mode & bit ? [name] : []));
  const named = special.length ? ` (${special.join(", ")})` : "";
  return `${path}: mode ${mode.toString(8).padStart(4, "0")}${named}, where npm pack writes 0644 or 0755`;
}

function pathFinding(e: Entry, { denied, allowed }: Rules, shipped: Set<string>): string | undefined {
  if (e.type !== "0")
    return `${e.path}: ${TYPES[parseInt(e.type)] || `tar entry type ${JSON.stringify(e.type)}`}${e.link && ` to ${e.link}`}`;
  if (escapes(e.path)) return `${e.path}: outside package/`;
  const parent = fileParent(e.path, shipped);
  if (parent) return `${e.path}: inside ${parent}, which is a file`;
  const deny = denied(e.path.slice("package/".length));
  if (deny) return `${e.path}: ${deny}`;
  if (!allowed(e.path.slice("package/".length))) return `${e.path}: not in package.json "files"`;
  return modeFinding(e);
}

// Every record file in the tarball is the checkout's copy.
const changedRecords = (files: Map<string, Entry>, root: string) =>
  [...files]
    .filter(([path]) => path.startsWith("package/packs/"))
    .flatMap(([path, e]) => {
      const local = join(root, path.slice("package/".length));
      if (!statSync(local, { throwIfNoEntry: false })?.isFile()) return [`${path}: not in the checkout`];
      return readFileSync(local).equals(e.data) ? [] : [`${path}: differs from the checkout's copy`];
    });

// Every record file the checkout would ship is in the tarball.
const missingRecords = (files: Map<string, Entry>, root: string, r: Rules) =>
  readdirSync(join(root, "packs"), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(root, join(d.parentPath, d.name)).split("\\").join("/"))
    .filter((rel) => r.allowed(rel) && !r.denied(rel) && !files.has(`package/${rel}`))
    .map((rel) => `${rel}: in the checkout but not in the tarball`);

function manifestFindings(files: Map<string, Entry>, root: string, version: string | undefined): string[] {
  const manifest = files.get("package/package.json");
  if (!manifest) return ["package/package.json: missing"];
  const out = manifest.data.equals(readFileSync(join(root, "package.json")))
    ? []
    : ["package/package.json: differs from the checkout's package.json"];
  const pkg = JSON.parse(manifest.data.toString("utf8")) as Manifest;
  for (const target of Object.values(pkg.bin ?? {}))
    if (!files.has(posix.join("package", target)))
      out.push(`package/package.json: bin ${target} is not in the tarball`);
  if (version !== undefined && pkg.version !== version)
    out.push(`package/package.json: version ${pkg.version}, expected ${version}`);
  return out;
}

// At most MAX_READ bytes of a regular file; a device, pipe or larger file is refused before it fills memory.
function readBounded(file: string): Buffer {
  if (!statSync(file).isFile()) throw new Error(`${file}: not a regular file`);
  const buf = Buffer.alloc(MAX_READ + 1);
  const fd = openSync(file, "r");
  let n = 0;
  try {
    for (let got = 1; got > 0 && n < buf.length; n += got) got = readSync(fd, buf, n, buf.length - n, null);
  } finally {
    closeSync(fd);
  }
  if (n > MAX_READ) throw new Error(`${file}: more than ${MAX_READ} bytes`);
  return buf.subarray(0, n);
}

function unpack(file: string): Buffer {
  const packed = readBounded(file);
  try {
    return gunzipSync(packed, { maxOutputLength: MAX_READ });
  } catch (e) {
    const big = (e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE";
    throw new Error(`${file}: ${big ? `unpacks to more than ${MAX_READ} bytes` : (e as Error).message}`, { cause: e });
  }
}

export function checkPackage(file: string, options: { root?: string; version?: string | undefined } = {}): string[] {
  const { root = ROOT, version } = options;
  const tar = unpack(file);
  const entries = readTar(tar);
  const r = rules(root);
  const shipped = new Set(entries.filter((e) => e.type === "0").map((e) => e.path));
  const found = entries.map((e) => pathFinding(e, r, shipped));
  const files = new Map(entries.filter((_, i) => !found[i]).map((e) => [e.path, e]));
  const unpacked = entries.reduce((sum, e) => sum + e.size, 0);
  return [
    ...listingFindings(entries, tar),
    ...found.filter((f) => f !== undefined),
    ...changedRecords(files, root),
    ...missingRecords(files, root, r),
    ...manifestFindings(files, root, version),
    ...(unpacked > MAX_UNPACKED ? [`unpacks to ${unpacked} bytes, more than ${MAX_UNPACKED}`] : []),
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
