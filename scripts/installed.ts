// A darnit CLI other than the build, for checks that should run on the exact file users install.
// Usage: tsx scripts/installed.ts --tarball <path> --integrity <sha512-...>
// installs the tarball the way scripts/e2e.ts does, checking its integrity, and prints the installed CLI's path.
import { spawnSync } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { givenTarball, installTarball, npmInstall } from "./e2e-env.js";

/** The CLI at `path`, relative to where npm was run as --tarball is, and its version; throws unless node runs it. */
export function cliAt(path: string): { path: string; version: string } {
  const cli = resolve(process.env.INIT_CWD || process.cwd(), path);
  if (!statSync(cli, { throwIfNoEntry: false })?.isFile()) throw new Error(`--cli ${cli} is not a file`);
  const r = spawnSync(process.execPath, [cli, "--version"], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, DARNIT_NO_UPDATE_CHECK: "1" },
  });
  const version = r.stdout?.trim() ?? "";
  if (r.status === 0 && /^\d+\.\d+\.\d+\S*$/.test(version)) return { path: cli, version };
  const why = /^\w*Error\b.*$/m.exec(r.stderr ?? "")?.[0] ?? `printed ${JSON.stringify(version.slice(0, 80))}`;
  throw new Error(`--cli ${cli} does not run: --version exited ${r.status ?? r.signal ?? r.error?.message}, ${why}`);
}

/** What `parse` returns, or exit 2 with `name: <message>` and no stack trace: a usage error is never a result. */
export function usage<T>(name: string, parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    console.error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

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
