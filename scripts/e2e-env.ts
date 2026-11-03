import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

// CI sets npm's script-shell so that a change's .npmrc cannot replace its own npm runs. A user's shell does
// not, and npm would let it override a scenario's .npmrc, so scenarios run without it, in any spelling npm reads.
const scriptShell = (key: string) => /^npm_config_script[-_]shell$/i.test(key);

/** `env` as a user's shell has it: without CI's npm script-shell setting. */
export const userEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([k]) => !scriptShell(k)));

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
  for (const k of ["tarball", "integrity"] as const) if ((values[k]?.length ?? 0) > 1) throw new Error(`--${k} is given more than once`);
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
export function installTarball(work: string, given: Tarball | undefined, pack: (dest: string) => void, install: (tarball: string, dir: string) => string) {
  const tarball = join(work, "darnit.tgz");
  if (given) copyFileSync(given.tarball, tarball);
  else {
    pack(work);
    renameSync(join(work, readdirSync(work).find((f) => f.endsWith(".tgz"))!), tarball);
  }
  const sri = integrity(tarball);
  if (given && sri !== given.integrity) throw new Error(`${given.tarball} has integrity ${sri}, expected ${given.integrity}`);
  const dir = join(work, "install");
  mkdirSync(dir);
  const version = install(tarball, dir);
  const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")) as { packages: Record<string, { integrity?: string }> };
  const installed = lock.packages["node_modules/darnit"]?.integrity;
  if (installed !== sri) throw new Error(`npm installed darnit with integrity ${installed}, expected ${sri}`);
  return {
    install: dir,
    line: `darnit ${version} from ${given?.tarball ?? tarball}, integrity ${installed}`,
    env: { DARNIT_TARBALL: tarball },
    packed: (cmd: string) => cmd.replace(/darnit@\S+/, () => '--package="$DARNIT_TARBALL" darnit'),
  };
}
