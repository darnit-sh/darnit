import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect } from "vitest";

// A copy of this repository to plant changes in, and the allowlist check run on it, for the allowlist tests.

const ROOT = join(import.meta.dirname, "..");
const tsx = join(ROOT, "node_modules", ".bin", "tsx");
const COPIED = ["src", "scripts", "test", ".gitignore", "package.json", "knip.json", "tsconfig.json", "tsconfig.build.json", "vitest.config.ts", "coverage-thresholds.json", "eslint.config.js"];

export const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** This repository's code and configs in a temporary folder, with its node_modules linked in. */
export async function copy() {
  const dir = await mkdtemp(join(tmpdir(), "darnit-allowlist-"));
  tempDirs.push(dir);
  await Promise.all(COPIED.map((p) => cp(join(ROOT, p), join(dir, p), { recursive: true })));
  await symlink(join(ROOT, "node_modules"), join(dir, "node_modules"));
  return dir;
}

export const run = (kind: "unused" | "duplicates", root = ROOT, env: NodeJS.ProcessEnv = process.env) => {
  const r = spawnSync(tsx, ["scripts/allowlist.ts", kind, "--root", root], { cwd: ROOT, encoding: "utf8", env });
  return { status: r.status, out: r.stdout + r.stderr };
};

export const edit = async (file: string, from: string, to: string) => {
  const text = await readFile(file, "utf8");
  expect(text).toContain(from);
  await writeFile(file, text.replace(from, to));
};

/** A 60 line function; `rename` swaps every name in it, as a copy with variables renamed would. */
export function block(rename: (name: string) => string) {
  const body = Array.from({ length: 57 }, (_, i) => `  const ${rename(`part${i}`)} = ${rename("input")}.slice(${i}, ${i + 3}).trim() + ${rename("sep")};`);
  return [`export function ${rename("pieces")}(${rename("input")}: string, ${rename("sep")}: string): number {`, ...body, `  return ${rename("part0")}.length;`, "}", ""].join("\n");
}
