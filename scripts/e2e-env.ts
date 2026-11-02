import { createHash } from "node:crypto";
import { copyFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
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
export function givenTarball(args: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Tarball | undefined {
  const flag = { type: "string", multiple: true } as const;
  const { values } = parseArgs({ args, options: { tarball: flag, integrity: flag }, strict: true });
  if (!values.tarball && !values.integrity) return undefined;
  for (const k of ["tarball", "integrity"] as const) if ((values[k]?.length ?? 0) > 1) throw new Error(`--${k} is given more than once`);
  const [path, sri] = [values.tarball?.[0], values.integrity?.[0]];
  if (!path || !sri) throw new Error("--tarball and --integrity go together: give both or neither");
  const tarball = resolve(env.INIT_CWD || cwd, path);
  if (!statSync(tarball, { throwIfNoEntry: false })?.isFile()) throw new Error(`${tarball} is not a file`);
  if (!tarball.endsWith(".tgz")) throw new Error(`${tarball} is not a .tgz tarball`);
  return { tarball, integrity: sri };
}

/**
 * The tarball every scenario installs, in `work`: the one `pack` writes there, or a copy of the given one, checked
 * after copying so that changing the given file later changes nothing. Throws when the copy's integrity differs.
 */
export function tarballIn(work: string, given: Tarball | undefined, pack: (dest: string) => void): Tarball {
  if (!given) {
    pack(work);
    const tarball = join(work, readdirSync(work).find((f) => f.endsWith(".tgz"))!);
    return { tarball, integrity: integrity(tarball) };
  }
  const tarball = join(work, basename(given.tarball));
  copyFileSync(given.tarball, tarball);
  const got = integrity(tarball);
  if (got !== given.integrity) throw new Error(`${given.tarball} has integrity ${got}, expected ${given.integrity}`);
  return { tarball, integrity: got };
}

/** The integrity npm recorded for the darnit it installed in `install`. Throws unless it is `want`. */
export function installedIntegrity(install: string, want: string): string {
  const lock = JSON.parse(readFileSync(join(install, "package-lock.json"), "utf8")) as { packages: Record<string, { integrity?: string }> };
  const got = lock.packages["node_modules/darnit"]?.integrity;
  if (got !== want) throw new Error(`npm installed darnit with integrity ${got}, expected ${want}`);
  return got;
}

export const fromLine = (version: string, tarball: string, sri: string) => `darnit ${version} from ${tarball}, integrity ${sri}`;

/** `cmd` with `darnit@<pin>` replaced by the tarball, quoted for sh, so any path stays one literal word. */
export const withTarball = (cmd: string, tarball: string) =>
  cmd.replace(/darnit@\S+/, () => `--package='${tarball.replaceAll("'", "'\\''")}' darnit`);
