import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fromLine, givenTarball, installedIntegrity, integrity, notUser, tarballIn, userEnv, withTarball } from "../scripts/e2e-env.js";

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
    expect(givenTarball(["--tarball", packed!.filename, "--integrity", "sha512-x"], {}, dir)).toEqual({ tarball, integrity: "sha512-x" });
    expect(givenTarball([`--tarball=${tarball}`, "--integrity=sha512-x"])).toEqual({ tarball, integrity: "sha512-x" });
    // npm run starts the script in the package folder; the path is relative to where npm was run.
    expect(givenTarball(["--tarball", packed!.filename, "--integrity", "sha512-x"], { INIT_CWD: dir }, "/")).toEqual({ tarball, integrity: "sha512-x" });
  });

  it("is copied into the work folder and checked there, so swapping the given file later changes nothing", () => {
    const work = mkdtempSync(join(dir, "work-"));
    const given = join(dir, "given.tgz");
    writeFileSync(given, readFileSync(tarball));
    const packs: string[] = [];
    const got = tarballIn(work, { tarball: given, integrity: packed!.integrity }, (dest) => packs.push(dest));
    expect(packs).toEqual([]);
    expect(got).toEqual({ tarball: join(work, "given.tgz"), integrity: packed!.integrity });
    writeFileSync(given, bytes);
    expect(integrity(got.tarball)).toBe(packed!.integrity);
    expect(() => tarballIn(mkdtempSync(join(dir, "work-")), { tarball: given, integrity: packed!.integrity }, () => {})).toThrow(
      `${given} has integrity ${integrity(changed)}, expected ${packed!.integrity}`,
    );
  });

  it("is packed into the work folder without flags", () => {
    const work = mkdtempSync(join(dir, "work-"));
    const got = tarballIn(work, undefined, (dest) => writeFileSync(join(dest, "darnit-1.0.0.tgz"), readFileSync(tarball)));
    expect(got).toEqual({ tarball: join(work, "darnit-1.0.0.tgz"), integrity: packed!.integrity });
  });

  it("is the file npm installed, by the integrity in the install's lockfile, and the printed line names it", () => {
    const install = mkdtempSync(join(dir, "install-"));
    const lock = (sri?: string) =>
      writeFileSync(join(install, "package-lock.json"), JSON.stringify({ packages: { "node_modules/darnit": sri ? { integrity: sri } : {} } }));
    lock(packed!.integrity);
    expect(installedIntegrity(install, packed!.integrity)).toBe(packed!.integrity);
    lock(integrity(changed));
    expect(() => installedIntegrity(install, packed!.integrity)).toThrow(`with integrity ${integrity(changed)}, expected ${packed!.integrity}`);
    lock();
    expect(() => installedIntegrity(install, packed!.integrity)).toThrow("with integrity undefined");
    expect(fromLine("1.0.0", tarball, packed!.integrity)).toBe(`darnit 1.0.0 from ${tarball}, integrity ${packed!.integrity}`);
  });

  it("stands in for darnit@<pin> in a workflow line as one literal word, whatever the path holds", () => {
    const path = `/tmp/it's $$ $& $' $1 \\ "x".tgz`;
    const r = spawnSync("sh", ["-c", withTarball("printf '%s\\n' darnit@0.2.0 check", path)], { encoding: "utf8" });
    expect(r.stdout).toBe(`--package=${path}\ndarnit\ncheck\n`);
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
