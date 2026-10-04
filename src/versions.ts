import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type Ecosystem = "npm" | "pypi";

/** A package version found in the repo, and the file that said so. */
export type Found = { version: string; from: string };

const read = (path: string) => readFile(path, "utf8").catch(() => undefined);
const VERSION = /^\d+\.\d+\.\d+/;

/** True if `version` is at least `min`. Both x.y.z; anything after the patch number is ignored. */
export function atLeast(version: string, min: string): boolean {
  const a = version.split(".").map((n) => parseInt(n, 10));
  const b = min.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/** Python package names compare case-insensitively, with -, _ and . interchangeable. */
const pyName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

async function npmVersion(root: string, pkg: string): Promise<Found | undefined> {
  const installed = await read(join(root, "node_modules", pkg, "package.json"));
  if (installed) {
    const v = (JSON.parse(installed) as { version?: string }).version;
    if (v && VERSION.test(v)) return { version: v, from: `node_modules/${pkg}` };
  }
  const lock = await read(join(root, "package-lock.json"));
  if (lock) {
    const v = (JSON.parse(lock) as { packages?: Record<string, { version?: string }> }).packages?.[`node_modules/${pkg}`]?.version;
    if (v && VERSION.test(v)) return { version: v, from: "package-lock.json" };
  }
  return undefined;
}

async function pypiVersion(root: string, pkg: string): Promise<Found | undefined> {
  const want = pyName(pkg);
  const requirements = (await readdir(root).catch(() => [])).filter((f) => /^requirements[^/]*\.txt$/.test(f)).sort();
  for (const file of requirements) {
    for (const line of (await read(join(root, file)))?.split("\n") ?? []) {
      const m = /^\s*([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*==\s*(\d+\.\d+\.\d+)/.exec(line);
      if (m && pyName(m[1]!) === want) return { version: m[2]!, from: file };
    }
  }
  // poetry.lock and uv.lock both list packages as [[package]] blocks with name and version lines.
  for (const file of ["poetry.lock", "uv.lock"]) {
    const text = await read(join(root, file));
    for (const block of text?.split("[[package]]").slice(1) ?? []) {
      const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
      const version = /^version\s*=\s*"(\d+\.\d+\.\d+)/m.exec(block)?.[1];
      if (name && version && pyName(name) === want) return { version, from: file };
    }
  }
  return undefined;
}

/** The version of `pkg` this repo uses, from what it has installed or locked. Undefined when nothing says. */
export function installedVersion(root: string, ecosystem: Ecosystem, pkg: string): Promise<Found | undefined> {
  return ecosystem === "npm" ? npmVersion(root, pkg).catch(() => undefined) : pypiVersion(root, pkg);
}
