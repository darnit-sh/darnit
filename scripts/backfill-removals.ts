import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { removalsFrom, type Removal } from "../src/corpus/accounting.js";
import { changelog } from "../src/corpus/oasdiff.js";

// Rebuilds corpus/<vendor>/removals.json from git history: every snapshot of the vendor's spec is
// diffed against the one before it, and each removal is dated by the newer snapshot's fetchedAt, as
// the corpus run would have logged it. Needs the full history: a shallow clone is refused, not half-read.
// --root <dir> rebuilds the log of another checkout.

const exec = promisify(execFile);
const at = process.argv.indexOf("--root");
const ROOT = at > 0 ? resolve(process.argv[at + 1] ?? "") : fileURLToPath(new URL("../", import.meta.url));
const git = async (...args: string[]) => (await exec("git", args, { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 })).stdout;

if ((await git("rev-parse", "--is-shallow-repository")).trim() !== "false") {
  console.error("The clone is shallow, so older snapshots are missing: run git fetch --unshallow first.");
  process.exit(1);
}
const vendors = Object.keys(parseYaml(await readFile(join(ROOT, "vendors.yml"), "utf8")) as Record<string, unknown>);
const tmp = await mkdtemp(join(tmpdir(), "darnit-backfill-"));
try {
  for (const vendor of vendors) {
    const spec = `corpus/${vendor}/openapi.yaml`;
    const commits = (await git("log", "--reverse", "--format=%H", "--", spec)).split("\n").filter(Boolean);
    const removals: Removal[] = [];
    for (const [i, commit] of commits.entries()) {
      await writeFile(join(tmp, `${i}.yaml`), await git("show", `${commit}:${spec}`));
      if (i === 0) continue;
      const { fetchedAt } = JSON.parse(await git("show", `${commit}:corpus/${vendor}/snapshot.json`)) as { fetchedAt: string };
      removals.push(...removalsFrom(await changelog(join(tmp, `${i - 1}.yaml`), join(tmp, `${i}.yaml`)), fetchedAt));
    }
    await writeFile(join(ROOT, "corpus", vendor, "removals.json"), `${JSON.stringify(removals, null, 2)}\n`);
    console.log(`${vendor}: ${removals.length} removals from ${Math.max(0, commits.length - 1)} snapshot diffs`);
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}
