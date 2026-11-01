import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
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

/** The tarball given as `--tarball <path> --integrity <sha512-...>`, or undefined to pack one. Throws on a usage error. */
export function givenTarball(args: string[], cwd = process.cwd()): { tarball: string; integrity: string } | undefined {
  const { values } = parseArgs({ args, options: { tarball: { type: "string" }, integrity: { type: "string" } }, strict: true });
  if (values.tarball === undefined && values.integrity === undefined) return undefined;
  if (!values.tarball || !values.integrity) throw new Error("--tarball and --integrity go together: give both or neither");
  const tarball = resolve(cwd, values.tarball);
  if (!statSync(tarball, { throwIfNoEntry: false })?.isFile()) throw new Error(`${tarball} is not a file`);
  if (!tarball.endsWith(".tgz")) throw new Error(`${tarball} is not a .tgz tarball`);
  return { tarball, integrity: values.integrity };
}
