import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { givenTarball, integrity, notUser, userEnv } from "../scripts/e2e-env.js";

describe("the environment end-to-end scenarios run with", () => {
  it("drops CI's npm script-shell setting in every spelling npm reads, and keeps the rest", () => {
    const shells = ["npm_config_script_shell", "NPM_CONFIG_SCRIPT_SHELL", "npm_config_script-shell", "Npm_Config_Script_Shell"];
    const env = { PATH: "/bin", npm_config_cache: "/c", NPM_CONFIG_SCRIPT: "x", ...Object.fromEntries(shells.map((k) => [k, "/bin/sh"])) };
    expect(userEnv(env)).toEqual({ PATH: "/bin", npm_config_cache: "/c", NPM_CONFIG_SCRIPT: "x" });
    expect(notUser(env)).toEqual(shells);
    expect(notUser(userEnv(env))).toEqual([]);
  });
});

describe("the tarball end-to-end scenarios install", () => {
  const dir = mkdtempSync(join(tmpdir(), "darnit-e2e-tarball-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // A small package packed by npm itself, so its integrity is the one npm writes.
  const pkg = join(dir, "pkg");
  mkdirSync(pkg);
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "e2e-pack", version: "1.0.0" }));
  writeFileSync(join(pkg, "index.js"), "export {};\n");
  const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--silent", "--pack-destination", dir], { cwd: pkg, encoding: "utf8" })) as {
    filename: string;
    integrity: string;
  }[];
  const tarball = join(dir, packed!.filename);
  const changed = join(dir, "changed.tgz");
  const bytes = readFileSync(tarball);
  bytes[bytes.length - 1]! ^= 1;
  writeFileSync(changed, bytes);
  const e2e = (...args: string[]) =>
    spawnSync(resolve("node_modules/.bin/tsx"), ["scripts/e2e.ts", ...args], { encoding: "utf8", timeout: 20_000 });

  it("has the integrity npm pack reports, and another after a one-byte change", () => {
    expect(integrity(tarball)).toBe(packed!.integrity);
    expect(integrity(tarball)).toBe(`sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`);
    expect(integrity(changed)).not.toBe(packed!.integrity);
  });

  it("is packed here without flags, or given with both --tarball and --integrity as an absolute path", () => {
    expect(givenTarball([])).toBeUndefined();
    expect(givenTarball(["--tarball", packed!.filename, "--integrity", "sha512-x"], dir)).toEqual({ tarball, integrity: "sha512-x" });
    expect(givenTarball([`--tarball=${tarball}`, "--integrity=sha512-x"])).toEqual({ tarball, integrity: "sha512-x" });
  });

  it("exits 2 for one flag without the other, a missing file, a folder, a non-.tgz file or an unknown argument", () => {
    writeFileSync(join(dir, "pkg.tar"), "x");
    mkdirSync(join(dir, "folder.tgz"));
    for (const [args, says] of [
      [["--tarball", tarball], "--tarball and --integrity go together"],
      [["--integrity", packed!.integrity], "--tarball and --integrity go together"],
      [["--tarball", tarball, "--integrity", ""], "--tarball and --integrity go together"],
      [["--tarball", "", "--integrity", packed!.integrity], "--tarball and --integrity go together"],
      [["--tarball", join(dir, "missing.tgz"), "--integrity", packed!.integrity], "is not a file"],
      [["--tarball", join(dir, "folder.tgz"), "--integrity", packed!.integrity], "is not a file"],
      [["--tarball", join(dir, "pkg.tar"), "--integrity", packed!.integrity], "is not a .tgz"],
      [["--tarball", tarball, "--integrity", packed!.integrity, "--tarbal", "x"], "Unknown option"],
      [["--tarball", tarball, "--integrity", packed!.integrity, "extra"], "Unexpected argument"],
    ] as const) {
      const r = e2e(...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr, args.join(" ")).toContain(says);
    }
  });

  it("exits 1 naming both values when the file's integrity differs, before installing anything", () => {
    const r = e2e("--tarball", changed, "--integrity", packed!.integrity);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(packed!.integrity);
    expect(r.stderr).toContain(integrity(changed));
    expect(r.stdout).not.toContain(" from ");
  });
});
