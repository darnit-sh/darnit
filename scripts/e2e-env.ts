// CI sets npm's script-shell so that a change's .npmrc cannot replace its own npm runs. A user's shell does
// not, and npm would let it override a scenario's .npmrc, so scenarios run without it, in any spelling npm reads.
const scriptShell = (key: string) => /^npm_config_script[-_]shell$/i.test(key);

/** `env` as a user's shell has it: without CI's npm script-shell setting. */
export const userEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([k]) => !scriptShell(k)));

/** The settings in `env` that a user's shell does not have. */
export const notUser = (env: NodeJS.ProcessEnv) => Object.keys(env).filter(scriptShell);
