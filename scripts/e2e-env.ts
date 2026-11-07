import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout: 5 * 60 * 1000 });
  if (r.error) return { exit: -1, out: `${cmd} did not finish: ${r.error.message}` };
  return { exit: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

export function must(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  const r = run(cmd, args, cwd, env);
  if (r.exit !== 0) throw new Error(`${cmd} ${args.join(" ")} failed in ${cwd}:\n${r.out}`);
  return r.out;
}

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

/** Installs `tarball` into the empty folder `dir` with npm, as a user would, and returns the version darnit prints. */
export function npmInstall(tarball: string, dir: string): string {
  must("npm", ["init", "-y"], dir);
  must("npm", ["install", "--silent", tarball], dir);
  return must(join(dir, "node_modules", ".bin", "darnit"), ["--version"], dir).trim();
}

// CI sets npm's script-shell so that a change's .npmrc cannot replace its own npm runs. A user's shell does
// not, and npm would let it override a scenario's .npmrc, so scenarios run without it, in any spelling npm reads.
const scriptShell = (key: string) => /^npm_config_script[-_]shell$/i.test(key);

/** `env` as a user's shell has it: without CI's npm script-shell setting. */
export const userEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !scriptShell(k)));

/** The settings in `env` that a user's shell does not have. */
export const notUser = (env: NodeJS.ProcessEnv) => Object.keys(env).filter(scriptShell);

/** The integrity npm writes for a tarball: sha512- and the base64 SHA-512 digest of its bytes. */
export const integrity = (file: string) => `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;

type Tarball = { tarball: string; integrity: string };

/**
 * The tarball given as `--tarball <path> --integrity <sha512-...>`, or undefined to pack one. Throws on a usage error.
 * Under npm run the script starts in the package folder, so a relative path is taken from where npm was run.
 */
export function givenTarball(args: string[]): Tarball | undefined {
  const flag = { type: "string", multiple: true } as const;
  const { values } = parseArgs({ args, options: { tarball: flag, integrity: flag }, strict: true });
  if (!values.tarball && !values.integrity) return undefined;
  for (const k of ["tarball", "integrity"] as const)
    if ((values[k]?.length ?? 0) > 1) throw new Error(`--${k} is given more than once`);
  const [path, sri] = [values.tarball?.[0], values.integrity?.[0]];
  if (!path || !sri) throw new Error("--tarball and --integrity go together: give both or neither");
  const tarball = resolve(process.env.INIT_CWD || process.cwd(), path);
  if (!statSync(tarball, { throwIfNoEntry: false })?.isFile()) throw new Error(`${tarball} is not a file`);
  if (!tarball.endsWith(".tgz")) throw new Error(`${tarball} is not a .tgz tarball`);
  return { tarball, integrity: sri };
}

/**
 * Installs the tarball every scenario runs, as `darnit.tgz` in `work`: the one `pack` writes there, or a copy of the
 * given one, checked after copying so that changing the given file later changes nothing. Neither the given path nor
 * the name npm packs to reaches a command line. `install` installs a tarball into a folder and returns darnit's
 * version; npm's lockfile there must show the checked integrity. Only that tarball is used after this: `packed` puts
 * `$DARNIT_TARBALL` in place of `darnit@<pin>` in a command run with `env`, so the path never becomes shell text.
 */
export function installTarball(
  work: string,
  given: Tarball | undefined,
  pack: (dest: string) => void,
  install: (tarball: string, dir: string) => string,
) {
  const tarball = join(work, "darnit.tgz");
  if (given) copyFileSync(given.tarball, tarball);
  else {
    pack(work);
    renameSync(
      join(
        work,
        readdirSync(work).find((f) => f.endsWith(".tgz"))!,
      ),
      tarball,
    );
  }
  const sri = integrity(tarball);
  if (given && sri !== given.integrity)
    throw new Error(`${given.tarball} has integrity ${sri}, expected ${given.integrity}`);
  const dir = join(work, "install");
  mkdirSync(dir);
  const version = install(tarball, dir);
  const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")) as {
    packages: Record<string, { integrity?: string }>;
  };
  const installed = lock.packages["node_modules/darnit"]?.integrity;
  if (installed !== sri) throw new Error(`npm installed darnit with integrity ${installed}, expected ${sri}`);
  return {
    install: dir,
    line: `darnit ${version} from ${given?.tarball ?? tarball}, integrity ${installed}`,
    env: { DARNIT_TARBALL: tarball },
    packed: (cmd: string) => cmd.replace(/darnit@\S+/, () => '--package="$DARNIT_TARBALL" darnit'),
  };
}
