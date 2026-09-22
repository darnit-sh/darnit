import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { LANGS, type Lang } from "../records/schema.js";

// The one place rule packs are applied. The fixture runner and `fix` both use
// it, so a pack cannot behave differently for a user than it did in CI.

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

// A pack's "js" rules are written once, against the JavaScript grammar, but a
// repo's call sites live in .ts/.tsx too. ast-grep applies a rule only to files
// of its declared language, so each rule is applied once per grammar.
const GRAMMARS: Record<Lang, string[]> = {
  js: ["javascript", "typescript", "tsx"],
  py: ["python"],
};

function astGrepBinary(): string {
  const pkgPath = require.resolve("@ast-grep/cli/package.json");
  const pkg = require(pkgPath) as { bin: Record<string, string> };
  const rel = pkg.bin["ast-grep"];
  if (!rel) throw new Error("@ast-grep/cli does not expose an ast-grep bin");
  return join(dirname(pkgPath), rel);
}

/** A pack's rule files for one language, in the numeric order they must be applied. */
export async function ruleFiles(packDir: string, lang: Lang): Promise<string[]> {
  const dir = join(packDir, "rules", lang);
  const entries = await readdir(dir).catch(() => []);
  return entries
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => join(dir, f));
}

/** True when the pack ships rewrite rules for any language. */
export async function hasRules(packDir: string): Promise<boolean> {
  for (const lang of LANGS) if ((await ruleFiles(packDir, lang)).length > 0) return true;
  return false;
}

/**
 * Applies a pack's rules in place to `targets` (files or directories), each
 * rule once per grammar, in numeric order. Throws naming the rule on failure.
 */
export async function applyRules(packDir: string, targets: readonly string[]): Promise<void> {
  if (targets.length === 0) return;
  const tmp = await mkdtemp(join(tmpdir(), "darnit-rules-"));
  try {
    const bin = astGrepBinary();
    for (const lang of LANGS) {
      for (const [i, rule] of (await ruleFiles(packDir, lang)).entries()) {
        const doc = parseYaml(await readFile(rule, "utf8")) as { language: string };
        for (const grammar of GRAMMARS[lang]) {
          const variant = join(tmp, `${lang}-${i}-${grammar}.yml`);
          await writeFile(variant, toYaml({ ...doc, language: grammar }));
          try {
            await execFileAsync(bin, ["scan", "--rule", variant, "--update-all", ...targets]);
          } catch (err) {
            const { stderr } = err as { stderr?: string };
            throw new Error(`ast-grep failed on ${relative(packDir, rule)} (${grammar}): ${(stderr ?? String(err)).trim()}`);
          }
        }
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
