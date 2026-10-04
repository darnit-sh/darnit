import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type Ecosystem = "npm" | "pypi";

/** A package version found in the repo, and the file that said so. */
export type Found = { version: string; from: string };

const read = (path: string) => readFile(path, "utf8").catch(() => undefined);
const VERSION = /^\d+\.\d+\.\d+/;

/**
 * True if `version` is at least `min` (both x.y.z). A prerelease of the minimum, like
 * 4.60.0-beta.1 or 1.45.0rc1, comes before it and does not count.
 */
export function atLeast(version: string, min: string): boolean {
  const core = VERSION.exec(version)?.[0] ?? version;
  const a = core.split(".").map((n) => parseInt(n, 10));
  const b = min.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return version.length === core.length;
}

/** Python package names compare case-insensitively, with -, _ and . interchangeable. */
const pyName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

/** Folders from `dir` up to the repo root, nearest first, as paths relative to the root ("" is the root). */
function upward(dir: string): string[] {
  const dirs: string[] = [];
  for (let d = dir; ; d = dirname(d)) {
    dirs.push(d === "." ? "" : d);
    if (d === "." || d === "" || d === "/") return dirs;
  }
}

/**
 * The version of `pkg` the code in `file` gets, resolved the way Node does: the nearest
 * node_modules on the way up from the file, then the matching package-lock.json entry.
 */
export async function npmVersionFor(root: string, pkg: string, file: string): Promise<Found | undefined> {
  const dirs = upward(dirname(file));
  for (const d of dirs) {
    const installed = await read(join(root, d, "node_modules", pkg, "package.json"));
    const v = installed && (JSON.parse(installed) as { version?: string }).version;
    if (v && VERSION.test(v)) return { version: v, from: join(d, "node_modules", pkg) };
  }
  const lock = await read(join(root, "package-lock.json"));
  const packages = lock ? (JSON.parse(lock) as { packages?: Record<string, { version?: string }> }).packages : undefined;
  for (const d of dirs) {
    const v = packages?.[d ? `${d}/node_modules/${pkg}` : `node_modules/${pkg}`]?.version;
    if (v && VERSION.test(v)) return { version: v, from: "package-lock.json" };
  }
  return undefined;
}

async function pins(root: string, file: string, want: string): Promise<Found[]> {
  const found: Found[] = [];
  for (const line of (await read(join(root, file)))?.split("\n") ?? []) {
    const m = /^\s*([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*==\s*(\d+\.\d+\.\d+[^\s;,#]*)/.exec(line);
    if (m && pyName(m[1]!) === want) found.push({ version: m[2]!, from: file });
  }
  return found;
}

// poetry.lock and uv.lock both list packages as [[package]] blocks with name and version lines.
async function locked(root: string, file: string, want: string): Promise<Found[]> {
  const found: Found[] = [];
  for (const block of (await read(join(root, file)))?.split("[[package]]").slice(1) ?? []) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"(\d+\.\d+\.\d+[^"]*)"/m.exec(block)?.[1];
    if (name && version && pyName(name) === want) found.push({ version, from: file });
  }
  return found;
}

/**
 * The versions of `pkg` from the most authoritative place that names it: requirements.txt, then
 * poetry.lock or uv.lock, then any other requirements*.txt. Several entries mean the source itself
 * holds more than one (a lock with forked resolutions, say). Empty when nothing pins it.
 */
export async function pypiVersions(root: string, pkg: string): Promise<Found[]> {
  const want = pyName(pkg);
  const others = (await readdir(root).catch(() => []))
    .filter((f) => /^requirements[^/]*\.txt$/.test(f) && f !== "requirements.txt")
    .sort();
  for (const source of [
    () => pins(root, "requirements.txt", want),
    () => locked(root, "poetry.lock", want),
    () => locked(root, "uv.lock", want),
    ...others.map((f) => () => pins(root, f, want)),
  ]) {
    const found = await source();
    if (found.length > 0) return found;
  }
  return [];
}
