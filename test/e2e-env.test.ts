import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { givenTarball, installTarball, integrity, notUser, userEnv } from "../scripts/e2e-env.js";

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
  afterEach(() => vi.unstubAllEnvs());
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
    vi.stubEnv("INIT_CWD", "");
    expect(givenTarball([])).toBeUndefined();
    expect(givenTarball([`--tarball=${tarball}`, "--integrity=sha512-x"])).toEqual({ tarball, integrity: "sha512-x" });
    expect(givenTarball(["--tarball", relative(process.cwd(), tarball), "--integrity", "sha512-x"])).toEqual({ tarball, integrity: "sha512-x" });
    // npm run starts the script in the package folder; the path is relative to where npm was run.
    vi.stubEnv("INIT_CWD", dir);
    expect(givenTarball(["--tarball", packed!.filename, "--integrity", "sha512-x"])).toEqual({ tarball, integrity: "sha512-x" });
  });

  // npm as the scenarios run it: `pack` writes a tarball, `install` records what it installed in the lockfile.
  const npm = (lockSri?: string) => {
    const packs: string[] = [];
    const installs: string[] = [];
    const pack = (dest: string) => {
      packs.push(dest);
      writeFileSync(join(dest, "darnit-1.0.0.tgz"), readFileSync(tarball));
    };
    const install = (t: string, d: string) => {
      installs.push(t);
      writeFileSync(join(d, "package-lock.json"), JSON.stringify({ packages: { "node_modules/darnit": { integrity: lockSri ?? integrity(t) } } }));
      return "1.0.0";
    };
    return { packs, installs, pack, install };
  };
  const sh = (cmd: string, env: NodeJS.ProcessEnv) => spawnSync("sh", ["-c", cmd], { encoding: "utf8", env: { ...process.env, ...env } }).stdout;

  it("installs and runs only a checked copy of the given file, so swapping the file later changes nothing", () => {
    // Quotes, spaces, $ patterns and a backslash in the path reach npx as one literal word, through the environment.
    const odd = `it's $$ $& $' $1 \\ "x"`;
    const work = mkdtempSync(join(dir, `${odd} work-`));
    const given = join(dir, `${odd}.tgz`);
    writeFileSync(given, readFileSync(tarball));
    const copy = join(work, "darnit.tgz");
    const { packs, installs, pack, install } = npm();
    const got = installTarball(work, { tarball: given, integrity: packed!.integrity }, pack, install);
    writeFileSync(given, bytes);
    expect(packs).toEqual([]);
    expect(installs).toEqual([copy]);
    expect(got.install).toBe(join(work, "install"));
    expect(got.line).toBe(`darnit 1.0.0 from ${given}, integrity ${packed!.integrity}`);
    expect(sh(got.packed("printf '%s\\n' darnit@0.2.0 check"), got.env)).toBe(`--package=${copy}\ndarnit\ncheck\n`);
    expect(got.packed("npx darnit@0.2.0 check")).toBe('npx --package="$DARNIT_TARBALL" darnit check');
    expect(integrity(copy)).toBe(packed!.integrity);
  });

  it("installs nothing when the given file's integrity differs, and fails when npm's lockfile shows another", () => {
    const wrong = npm();
    expect(() => installTarball(mkdtempSync(join(dir, "work-")), { tarball: changed, integrity: packed!.integrity }, wrong.pack, wrong.install)).toThrow(
      `${changed} has integrity ${integrity(changed)}, expected ${packed!.integrity}`,
    );
    expect(wrong.installs).toEqual([]);
    const other = npm(integrity(changed));
    expect(() => installTarball(mkdtempSync(join(dir, "work-")), { tarball, integrity: packed!.integrity }, other.pack, other.install)).toThrow(
      `npm installed darnit with integrity ${integrity(changed)}, expected ${packed!.integrity}`,
    );
  });

  it("installs the tarball it packs into the work folder without flags", () => {
    const work = mkdtempSync(join(dir, "work-"));
    const { packs, installs, pack, install } = npm();
    const got = installTarball(work, undefined, pack, install);
    const own = join(work, "darnit.tgz");
    expect(packs).toEqual([work]);
    expect(installs).toEqual([own]);
    expect(got.line).toBe(`darnit 1.0.0 from ${own}, integrity ${packed!.integrity}`);
    expect(sh(got.packed("printf '%s\\n' darnit@0.2.0"), got.env)).toBe(`--package=${own}\ndarnit\n`);
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
      [["--tarball", tarball, "--tarball", changed, "--integrity", packed!.integrity], "--tarball is given more than once"],
      [["--tarball", tarball, "--integrity", "sha512-x", "--integrity", packed!.integrity], "--integrity is given more than once"],
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
