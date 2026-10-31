import { describe, expect, it } from "vitest";
import { notUser, userEnv } from "../scripts/e2e-env.js";

describe("the environment end-to-end scenarios run with", () => {
  it("drops CI's npm script-shell setting in every spelling npm reads, and keeps the rest", () => {
    const shells = ["npm_config_script_shell", "NPM_CONFIG_SCRIPT_SHELL", "npm_config_script-shell", "Npm_Config_Script_Shell"];
    const env = { PATH: "/bin", npm_config_cache: "/c", NPM_CONFIG_SCRIPT: "x", ...Object.fromEntries(shells.map((k) => [k, "/bin/sh"])) };
    expect(userEnv(env)).toEqual({ PATH: "/bin", npm_config_cache: "/c", NPM_CONFIG_SCRIPT: "x" });
    expect(notUser(env)).toEqual(shells);
    expect(notUser(userEnv(env))).toEqual([]);
  });
});
