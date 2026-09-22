import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

// Known vendors. "supported" = a rule pack exists in packs/; "detected" = named
// in config only. Extend by adding a row.
export const VENDORS = {
  openai: { npm: ["openai"], pypi: ["openai"], hosts: ["api.openai.com"], tier: "supported" },
  anthropic: { npm: ["@anthropic-ai/sdk"], pypi: ["anthropic"], hosts: ["api.anthropic.com"], tier: "detected" },
  stripe: { npm: ["stripe"], pypi: ["stripe"], hosts: ["api.stripe.com"], tier: "detected" },
  twilio: { npm: ["twilio"], pypi: ["twilio"], hosts: ["api.twilio.com"], tier: "detected" },
} as const;

export type Vendor = keyof typeof VENDORS;

export type Detection = {
  vendor: Vendor;
  /** Where it was seen, e.g. "package.json: openai" or "src/client.js: api.openai.com". */
  evidence: string[];
};

const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|build|coverage|\.venv|venv|__pycache__|\.next)(\/|$)/;
const SOURCE_FILE = /\.(m?[jt]sx?|c[jt]s|py)$/;
const PYTHON_MANIFEST = /^(requirements[^/]*\.txt|pyproject\.toml)$/;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Direct dependencies from a package.json, both prod and dev. */
function npmDeps(json: string): string[] {
  const pkg = JSON.parse(json) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
}

/** True if a requirements.txt / pyproject.toml names the package (with or without a version spec). */
function pythonDeclares(text: string, pkg: string): boolean {
  return new RegExp(`(^|["'\\s])${escapeRegExp(pkg)}(?=[\\s\\[=<>~!;"',]|$)`, "m").test(text);
}

/** Every path under root (relative, sorted), skipping vendored and build directories. */
export async function listFiles(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true })).filter((f) => !SKIP_DIRS.test(f)).sort();
}

/** Scans a repo for known vendor APIs. Sorted by vendor; evidence in path order. */
export async function detectApis(root: string): Promise<Detection[]> {
  // ponytail: reads every source file in full to look for host strings; stream or cap sizes if repos get huge
  const files = await listFiles(root);
  const evidence = new Map<Vendor, string[]>();
  const add = (vendor: Vendor, note: string) => evidence.set(vendor, [...(evidence.get(vendor) ?? []), note]);

  for (const file of files) {
    const name = basename(file);
    const isManifest = name === "package.json" || PYTHON_MANIFEST.test(name);
    if (!isManifest && !SOURCE_FILE.test(name)) continue;
    const text = await readFile(join(root, file), "utf8").catch(() => "");
    for (const [vendor, spec] of Object.entries(VENDORS) as [Vendor, (typeof VENDORS)[Vendor]][]) {
      if (name === "package.json") {
        for (const dep of npmDeps(text)) if ((spec.npm as readonly string[]).includes(dep)) add(vendor, `${file}: ${dep}`);
      } else if (isManifest) {
        for (const pkg of spec.pypi) if (pythonDeclares(text, pkg)) add(vendor, `${file}: ${pkg}`);
      } else {
        for (const host of spec.hosts) if (text.includes(host)) add(vendor, `${file}: ${host}`);
      }
    }
  }

  return [...evidence]
    .map(([vendor, notes]) => ({ vendor, evidence: notes }))
    .sort((a, b) => a.vendor.localeCompare(b.vendor));
}
