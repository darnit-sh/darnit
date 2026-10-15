import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import type { VendorClients } from "./scan/clients.js";
import { basename, join, resolve, sep } from "node:path";

// Known vendors. "supported" = a rule pack exists in packs/; "recognized" = named
// in config only. Extend by adding a row.
export const VENDORS = {
  openai: { name: "OpenAI", npm: ["openai"], pypi: ["openai"], hosts: ["api.openai.com", "openai.azure.com"], tier: "supported" },
  anthropic: { name: "Anthropic", npm: ["@anthropic-ai/sdk"], pypi: ["anthropic"], hosts: ["api.anthropic.com"], tier: "recognized" },
  stripe: { name: "Stripe", npm: ["stripe"], pypi: ["stripe"], hosts: ["api.stripe.com"], tier: "recognized" },
  twilio: { name: "Twilio", npm: ["twilio"], pypi: ["twilio"], hosts: ["api.twilio.com"], tier: "recognized" },
} as const;

export type Vendor = keyof typeof VENDORS;

/** A vendor's display name, e.g. "OpenAI" for openai; the id itself for vendors not in the table. */
export const vendorName = (id: string) => (VENDORS as Partial<Record<string, { name: string }>>)[id]?.name ?? id;

/** The packages and hosts that identify a vendor's own clients, for telling them apart from look-alikes. */
export function vendorClients(id: string): VendorClients | undefined {
  const v = (VENDORS as Partial<Record<string, (typeof VENDORS)[Vendor]>>)[id];
  if (!v) return undefined;
  const look = LOOKALIKES[id as Vendor];
  return { packages: [...v.npm, ...v.pypi], hosts: [...v.hosts], lookalikePackages: look?.packages ?? [], lookalikeHosts: look?.hosts ?? [] };
}

/**
 * Other providers whose SDKs, or whose addresses behind the vendor's own SDK, copy the vendor's
 * methods. Only these are ever left out as foreign; anything unlisted counts as the vendor.
 * Extend by adding a package (npm or PyPI import root) or host.
 */
const LOOKALIKES: Partial<Record<Vendor, { packages: string[]; hosts: string[] }>> = {
  openai: {
    packages: ["groq-sdk", "groq", "together-ai", "together", "@cerebras/cerebras_cloud_sdk", "cerebras", "fireworks"],
    hosts: [
      "openrouter.ai",
      "api.deepseek.com",
      "api.groq.com",
      "api.together.xyz",
      "api.together.ai",
      "api.fireworks.ai",
      "api.cerebras.ai",
      "api.x.ai",
      "api.mistral.ai",
      "api.perplexity.ai",
      "generativelanguage.googleapis.com",
      "volces.com",
    ],
  },
};

export type Detection = {
  vendor: Vendor;
  /** Where it was seen, e.g. "package.json: openai" or "src/client.js: api.openai.com". */
  evidence: string[];
};

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".next",
  "site-packages",
  ".tox",
  "vendor",
]);
const SOURCE_FILE = /\.(m?[jt]sx?|c[jt]s|py)$/;
const PYTHON_MANIFEST = /^(requirements[^/]*\.txt|pyproject\.toml|setup\.py|setup\.cfg|Pipfile)$/;

/** Larger files are not read: no hand-written source comes close, and a planted one could stall a scan or run it out of memory. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "a, b, c, d, e and 2 more" */
export const firstFive = (items: readonly string[]) => `${items.slice(0, 5).join(", ")}${items.length > 5 ? ` and ${items.length - 5} more` : ""}`;

/** The report line for files too large to read, if any. */
export const tooLargeNote = (files: readonly string[] = []) =>
  files.length > 0 ? [`Not checked: ${plural(files.length, "file")} over ${MAX_FILE_BYTES / 1024 / 1024} MB: ${firstFive(files)}.`] : [];

/** A folder or file the scan did not read, and why. "." is the repository folder. */
export type Skipped = {
  path: string;
  reason: "dependency or build folder" | "bundled SDK copy" | "symbolic link outside the repository" | "could not be read";
};

const SKIPPED_LINE: Record<Skipped["reason"], (paths: string[]) => string> = {
  "dependency or build folder": (p) => `${plural(p.length, "dependency or build folder")}: ${firstFive(p)}`,
  "bundled SDK copy": (p) => `${plural(p.length, "folder")} with a bundled copy of an SDK: ${firstFive(p)}`,
  "symbolic link outside the repository": (p) => `${plural(p.length, "symbolic link")} to outside the repository: ${firstFive(p)}`,
  "could not be read": (p) => `could not read ${firstFive(p.map((path) => (path === "." ? "the repository folder" : path)))}`,
};

/** One report line per reason for what the scan did not read. */
export const skippedNote = (skipped: readonly Skipped[] = []) =>
  (Object.keys(SKIPPED_LINE) as Skipped["reason"][]).flatMap((reason) => {
    const paths = skipped.filter((s) => s.reason === reason).map((s) => s.path);
    return paths.length > 0 ? [`Not checked: ${SKIPPED_LINE[reason](paths)}.`] : [];
  });

export const byPath = (a: Skipped, b: Skipped) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** A regular file's text; undefined when it can't be read, isn't a file, or is over MAX_FILE_BYTES (then `tooLarge` gets its first 8 KB). */
export async function readText(path: string, tooLarge?: (start: string) => void): Promise<string | undefined> {
  // Checked before opening, since opening a named pipe waits for a writer that never comes.
  const stats = await stat(path).catch(() => undefined);
  if (!stats?.isFile()) return undefined;
  // Non-blocking, so a named pipe swapped in after that check opens at once instead of waiting.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => undefined);
  try {
    // Checked again on what was opened, in case the path changed in between.
    const opened = await file?.stat();
    if (!opened?.isFile()) return undefined;
    // At most one byte past the limit, since the file can grow after the check.
    const end = opened.size > MAX_FILE_BYTES ? 8191 : MAX_FILE_BYTES;
    const data = Buffer.concat(await file!.createReadStream({ start: 0, end, autoClose: false }).toArray());
    if (opened.size <= MAX_FILE_BYTES && data.length <= MAX_FILE_BYTES) return data.toString("utf8");
    return void tooLarge?.(data.toString("utf8", 0, 8192));
  } catch {
    return undefined;
  } finally {
    await file?.close();
  }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A generated Python SDK (OpenAI's and its siblings) keeps all of these at its package root. */
const isBundledSdk = (names: Set<string>) => ["_base_client.py", "_client.py", "_exceptions.py"].every((n) => names.has(n));

/**
 * Every regular file under root as a sorted, forward-slash relative path.
 * Vendored and build directories, including SDK copies bundled into the project, are pruned
 * before they are entered, and unreadable ones are not fatal; both go to `skipped`, except .git (git's own data).
 * Symlinks are not followed: a target inside the repo is scanned at its own path, and a link to outside it goes to `skipped`.
 */
export async function listFiles(root: string, skipped: Skipped[] = []): Promise<string[]> {
  const files: string[] = [];
  const real = await realpath(root).catch(() => resolve(root));
  const outside = async (path: string) => {
    const target = await realpath(join(root, path)).catch(() => undefined);
    return target !== undefined && target !== real && !target.startsWith(real + sep);
  };
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => undefined);
    if (!entries) return void skipped.push({ path: rel || ".", reason: "could not be read" });
    if (rel && isBundledSdk(new Set(entries.filter((e) => e.isFile()).map((e) => e.name)))) return void skipped.push({ path: rel, reason: "bundled SDK copy" });
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory() && entry.name === ".git") continue;
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) skipped.push({ path, reason: "dependency or build folder" });
      else if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
      else if (entry.isSymbolicLink() && (await outside(path))) skipped.push({ path, reason: "symbolic link outside the repository" });
    }
  };
  await walk("");
  return files.sort();
}

/** Direct dependencies from a package.json, both prod and dev. Unparseable files count as none. */
function npmDeps(json: string): string[] {
  try {
    const pkg = JSON.parse((json.charCodeAt(0) === 0xfeff ? json.slice(1) : json)) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
  } catch {
    return [];
  }
}

/** True if a Python manifest declares the package: at a line start or as a list item, so comments and prose do not count. */
function pythonDeclares(text: string, pkg: string): boolean {
  return new RegExp(`(^|[\\[,]\\s*)["']?${escapeRegExp(pkg)}(?=[\\s\\[=<>~!;"',\\]]|$)`, "m").test(text);
}

/** True if a source file imports the package. */
function importsPackage(text: string, pkg: string, lang: "js" | "py"): boolean {
  const p = escapeRegExp(pkg);
  return lang === "py"
    ? new RegExp(`^[ \\t\\f]*(from|import)\\s+${p}\\b`, "m").test(text)
    : new RegExp(`(from\\s*|require\\(\\s*)["']${p}(/|["'])`).test(text);
}

/** Scans a repo for known vendor APIs. Sorted by vendor; evidence in path order. Files too large to read are added to `tooLarge`, folders not entered to `skipped`. */
export async function detectApis(root: string, tooLarge: string[] = [], skipped: Skipped[] = []): Promise<Detection[]> {
  const evidence = new Map<Vendor, string[]>();
  const add = (vendor: Vendor, note: string) => evidence.set(vendor, [...(evidence.get(vendor) ?? []), note]);

  for (const file of await listFiles(root, skipped)) {
    const name = basename(file);
    const isManifest = name === "package.json" || PYTHON_MANIFEST.test(name);
    const lang = SOURCE_FILE.test(name) ? (name.endsWith(".py") ? "py" : "js") : undefined;
    if (!isManifest && !lang) continue;
    let large = false;
    const text = await readText(join(root, file), () => {
      large = true;
      tooLarge.push(file);
    });
    if (text === undefined) {
      if (!large) skipped.push({ path: file, reason: "could not be read" });
      continue;
    }
    for (const [vendor, spec] of Object.entries(VENDORS) as [Vendor, (typeof VENDORS)[Vendor]][]) {
      if (name === "package.json") {
        for (const dep of npmDeps(text)) if ((spec.npm as readonly string[]).includes(dep)) add(vendor, `${file}: ${dep}`);
      } else if (isManifest) {
        for (const pkg of spec.pypi) if (pythonDeclares(text, pkg)) add(vendor, `${file}: ${pkg}`);
      } else if (lang) {
        for (const pkg of lang === "py" ? spec.pypi : spec.npm) if (importsPackage(text, pkg, lang)) add(vendor, `${file}: import ${pkg}`);
        for (const host of spec.hosts) if (text.includes(host)) add(vendor, `${file}: ${host}`);
      }
    }
  }

  skipped.sort(byPath);
  return [...evidence]
    .map(([vendor, notes]) => ({ vendor, evidence: notes }))
    .sort((a, b) => a.vendor.localeCompare(b.vendor));
}
