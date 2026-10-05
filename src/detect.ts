import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

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
export function vendorClients(id: string): { packages: string[]; hosts: string[] } | undefined {
  const v = (VENDORS as Partial<Record<string, (typeof VENDORS)[Vendor]>>)[id];
  return v ? { packages: [...v.npm, ...v.pypi], hosts: [...v.hosts] } : undefined;
}

export type Detection = {
  vendor: Vendor;
  /** Where it was seen, e.g. "package.json: openai" or "src/client.js: api.openai.com". */
  evidence: string[];
};

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
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

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every regular file under root as a sorted, forward-slash relative path.
 * Vendored and build directories are pruned before they are entered; unreadable
 * directories and symlinks are skipped rather than fatal.
 */
export async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) await walk(path);
      else if (entry.isFile()) files.push(path);
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
    ? new RegExp(`^\\s*(from|import)\\s+${p}\\b`, "m").test(text)
    : new RegExp(`(from\\s*|require\\(\\s*)["']${p}(/|["'])`).test(text);
}

/** Scans a repo for known vendor APIs. Sorted by vendor; evidence in path order. */
export async function detectApis(root: string): Promise<Detection[]> {
  // Known limit: every source file is read in full to look for host strings. Stream or cap sizes if repos get huge.
  const evidence = new Map<Vendor, string[]>();
  const add = (vendor: Vendor, note: string) => evidence.set(vendor, [...(evidence.get(vendor) ?? []), note]);

  for (const file of await listFiles(root)) {
    const name = basename(file);
    const isManifest = name === "package.json" || PYTHON_MANIFEST.test(name);
    const lang = SOURCE_FILE.test(name) ? (name.endsWith(".py") ? "py" : "js") : undefined;
    if (!isManifest && !lang) continue;
    const text = await readFile(join(root, file), "utf8").catch(() => "");
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

  return [...evidence]
    .map(([vendor, notes]) => ({ vendor, evidence: notes }))
    .sort((a, b) => a.vendor.localeCompare(b.vendor));
}
