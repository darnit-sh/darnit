// A darnit CLI other than the build, for checks that should run on the exact file users install.
// Usage: tsx scripts/installed.ts --tarball <path> --integrity <sha512-...>
// installs the tarball the way scripts/e2e.ts does, checking its integrity, and prints the installed CLI's path.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { givenTarball, installTarball, npmInstall, usage } from "./e2e-env.js";

function main() {
  const given = usage("installed", () => {
    const tarball = givenTarball(process.argv.slice(2));
    if (!tarball) throw new Error("give --tarball <path> --integrity <sha512-...>");
    return tarball;
  });
  // Only the given tarball is installed, so nothing is packed.
  const work = mkdtempSync(join(tmpdir(), "darnit-installed-"));
  const { install, line } = installTarball(work, given, () => {}, npmInstall);
  console.error(line);
  console.log(join(install, "node_modules", ".bin", "darnit"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
