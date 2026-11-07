import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkPackage, MAX_READ, MAX_UNPACKED, PREFIXED } from "../scripts/check-package.js";

const ROOT = join(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const PKG = await readFile(join(ROOT, "package.json"), "utf8");
const { version: VERSION } = JSON.parse(PKG) as { version: string };
type File = { path?: string; data?: string | Buffer; type?: string; link?: string; raw?: Buffer } & Partial<
  Record<"magic" | "prefix", string> & { pax: Record<string, string>; mode: number | string }
>;

// A tar writer that can write what npm never would: links, escaping paths, odd magic, paths only a pax header holds.
const field = (n: number, width: number) => `${n.toString(8).padStart(width - 1, "0")}\0`;
const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc(-b.length & 511)]);
function header(f: File, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(f.path ?? "", 0, 100);
  h.write(typeof f.mode === "string" ? f.mode : field(f.mode ?? 0o644, 8), 100);
  h.write(field(size, 12), 124);
  h.write(`${" ".repeat(8)}${f.type ?? "0"}`, 148);
  h.write(f.link ?? "", 157, 100);
  h.write(f.magic ?? "ustar\x0000", 257);
  h.write(f.prefix ?? "", 345, 155);
  const sum = h.reduce((total, b) => total + b, 0);
  h.write(field(sum, 7), 148);
  return h;
}
// Each pax record starts with its own length in bytes, that number included.
const paxData = (records: Record<string, string>) =>
  Object.entries(records).reduce((out, [key, value]) => {
    let n = Buffer.byteLength(` ${key}=${value}\n`);
    while (Buffer.byteLength(`${n} ${key}=${value}\n`) !== n) n++;
    return `${out}${n} ${key}=${value}\n`;
  }, "");
const tar = (files: File[]) =>
  Buffer.concat([
    ...files.flatMap((f) => {
      if (f.raw) return [f.raw];
      const data = Buffer.from(f.data ?? "");
      const ext = Buffer.from(paxData(f.pax ?? {}));
      const pax = f.pax ? [header({ path: "PaxHeader", type: "x" }, ext.length), pad(ext)] : [];
      return [...pax, header(f, data.length), pad(data)];
    }),
    Buffer.alloc(1024),
  ]);

let dir: string;
let base: File[];
let count = 0;
const write = async (files: File[], edit = (t: Buffer) => t) => {
  const file = join(dir, `${++count}.tgz`);
  await writeFile(file, gzipSync(edit(tar(files))));
  return file;
};
const check = async (files: File[], version?: string) => checkPackage(await write(files), { version });
const run = (args: string[], env = process.env) =>
  spawnSync(process.execPath, [TSX, "scripts/check-package.ts", ...args], { cwd: ROOT, encoding: "utf8", env });
const npm = (...args: string[]) => spawnSync("npm", args, { cwd: ROOT, encoding: "utf8" }).status;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "darnit-package-"));
  const records = (await readdir(join(ROOT, "packs"), { recursive: true, withFileTypes: true }))
    .filter((d) => d.isFile())
    .map((d) => relative(ROOT, join(d.parentPath, d.name)))
    .filter((p) => /\/change\.json$|\/rules\//.test(p));
  base = [
    { path: "package/package.json", data: PKG },
    { path: "package/dist/cli.js", data: "#!/usr/bin/env node\n", mode: 0o755 },
    ...(await Promise.all(records.map(async (p) => ({ path: `package/${p}`, data: await readFile(join(ROOT, p)) })))),
  ];
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("check-package", () => {
  it("passes the tarball npm packs from this repository, built as it is published", () => {
    expect([npm("run", "build"), npm("pack", "--pack-destination", dir)]).toEqual([0, 0]);
    const r = run([join(dir, `darnit-${VERSION}.tgz`), "--version", VERSION]);
    expect(r.stdout).toMatch(/^\S+: nothing that should not ship\n$/);
    expect(r.status).toBe(0);
  });

  it("finds a setuid file in a tarball npm packs, which npm pack keeps", () => {
    const helper = join(ROOT, "dist", "check.js");
    expect(npm("run", "build")).toBe(0);
    mkdirSync(join(dir, "setuid"));
    chmodSync(helper, 0o6777);
    try {
      expect(npm("pack", "--pack-destination", join(dir, "setuid"))).toBe(0);
    } finally {
      chmodSync(helper, 0o644);
    }
    const r = run([join(dir, "setuid", `darnit-${VERSION}.tgz`)]);
    expect(r.stdout).toMatch(/^package\/dist\/check\.js: mode [67]755 \(setuid/);
    expect(r.status).toBe(1);
  });

  it("passes the package.json and records as the checkout holds them", async () => {
    expect(await check(base, VERSION)).toEqual([]);
  });

  const add =
    (...extra: File[]) =>
    (b: File[]) => [...b, ...extra];
  const without = (path: string) => (b: File[]) => b.filter((f) => f.path !== path);
  const replace = (path: string, data: string) => (b: File[]) => b.map((f) => (f.path === path ? { ...f, data } : f));
  const record = () => base.find((f) => f.path!.endsWith("/change.json"))!.path!;
  const postinstall = PKG.replace('"scripts": {', '"scripts": {\n    "postinstall": "node -e 1",');
  it.each<[string, (b: File[]) => File[], RegExp]>([
    ["an extra .env", add({ path: "package/dist/.env", data: "KEY=1" }), /dist\/\.env: a dotfile/],
    ["an env file by another name", add({ path: "package/dist/prod.env" }), /prod\.env: an env file/],
    ["a test file", add({ path: "package/dist/cli.test.js" }), /cli\.test\.js: a test file/],
    ["a test file by name alone", add({ path: "package/dist/Test.JS" }), /Test\.JS: a test file/],
    ["a source map", add({ path: "package/dist/cli.js.map" }), /cli\.js\.map: a source map/],
    ["a key", add({ path: "package/packs/x/rules/id_rsa" }), /id_rsa: named like a key/],
    ["a certificate", add({ path: "package/dist/server.crt" }), /server\.crt: named like a key/],
    ["a credentials file", add({ path: "package/dist/credentials.json" }), /credentials\.json: named like a key/],
    ["a file outside files", add({ path: "package/src/cli.ts" }), /src\/cli\.ts: not in package\.json/],
    ["a changed record", (b) => replace(record(), "{}")(b), /differs from the checkout's copy/],
    ["a missing record", (b) => without(record())(b), /in the checkout but not in the tarball/],
    [
      "an extra record",
      add({ path: "package/packs/openai/new/change.json" }),
      /new\/change\.json: not in the checkout/,
    ],
    ["a missing package.json", without("package/package.json"), /^package\/package\.json: missing$/],
    ["a changed package.json", replace("package/package.json", postinstall), /differs from the checkout's package/],
    ["a symlink", add({ path: "package/dist/x.js", type: "2", link: "/etc/passwd" }), /symlink to \/etc/],
    ["a hard link", add({ path: "package/dist/x.js", type: "1", link: "package/dist/cli.js" }), /hard link/],
    ["a device", add({ path: "package/dist/x", type: "3" }), /package\/dist\/x: a device/],
    ["a ../ path", add({ path: "package/../evil.js" }), /evil\.js: outside package\//],
    ["an absolute path", add({ path: "/package/evil.js" }), /evil\.js: outside package\//],
    ["a backslash path", add({ path: "package/..\\evil.js" }), /evil\.js: outside package\//],
    ["a path in a pax header", add({ path: "package/dist/ok.js", pax: { path: "package/.env" } }), /\.env: a dot/],
    ["a GNU long name", add({ path: "L", type: "L", data: "package/.npmrc" }, { path: "package/a" }), /\.npmrc: a dot/],
    ["a missing bin", without("package/dist/cli.js"), /bin dist\/cli\.js is not in/],
    ["a setuid file", add({ path: "package/dist/a.js", mode: 0o6777 }), /a\.js: mode 6777 \(setuid, setgid\), where/],
    ["a sticky file", add({ path: "package/dist/a.js", mode: 0o1644 }), /a\.js: mode 1644 \(sticky\), where/],
    ["a file others can write", add({ path: "package/dist/a.js", mode: 0o666 }), /a\.js: mode 0666, where npm/],
    ["a file its owner cannot write", add({ path: "package/dist/a.js", mode: 0o444 }), /a\.js: mode 0444, where/],
    ["a file inside package.json", add({ path: "package/package.json/a.js" }), /inside package\/package\.json, which/],
    ["a file inside a file", add({ path: "package/CHANGELOG.md" }, { path: "package/CHANGELOG.md/a.js" }), /a file$/],
    ["over the size limit", add({ path: "package/dist/a.js", data: Buffer.alloc(MAX_UNPACKED) }), /more than/],
  ])("finds %s", async (_, breach, finding) => {
    expect(await check(breach(base), VERSION)).toEqual([expect.stringMatching(finding)]);
  });

  it("finds a mode the two readers read apart", async () => {
    expect(await check(add({ path: "package/dist/a.js", mode: " ".repeat(8) })(base))).toEqual([
      expect.stringMatching(
        /^npm's tar reads entry \d+ as package\/dist\/a\.js 0 0 undefined, this script as .* 0 0 0$/,
      ),
      "package/dist/a.js: mode 0000, where npm pack writes 0644 or 0755",
    ]);
  });

  it("finds a wrong version", async () => {
    expect(await check(base, "9.9.9")).toEqual([`package/package.json: version ${VERSION}, expected 9.9.9`]);
  });

  it("leaves out what a ! entry in files leaves out", async () => {
    const root = join(dir, "checkout");
    const manifest = JSON.stringify({ files: ["dist", "!dist/x.js"] });
    await mkdir(join(root, "packs"), { recursive: true });
    await writeFile(join(root, "package.json"), manifest);
    const files = [{ path: "package/package.json", data: manifest }, { path: "package/dist/y.js" }];
    expect(checkPackage(await write(files), { root })).toEqual([]);
    const extra = await write([...files, { path: "package/dist/x.js" }]);
    expect(checkPackage(extra, { root })).toEqual(['package/dist/x.js: not in package.json "files"']);
  });

  const cut = (t: Buffer) => t.subarray(0, t.length - 1024 - 1000);
  const big = async () => {
    await writeFile(join(dir, "big.tgz"), Buffer.alloc(MAX_READ + 1));
    return join(dir, "big.tgz");
  };
  const pax = { path: "package/a.js", pax: { path: "package/a.key\0.js" } };
  it.each<[string, () => Promise<string>, RegExp]>([
    ["data after one zero block", () => write(add({ raw: Buffer.alloc(512) }, { path: "package/a" })(base)), /zero/],
    ["a short magic", () => write(add({ path: "package/a", prefix: "package", magic: "ustar\0xx" })(base)), /magic/],
    ["a NUL in a pax path", () => write(add(pax)(base)), /NUL/],
    ["a record inside a pax value", () => write([{ path: "package/a", pax: { c: "x\n9 path=.e\n" } }]), /newline/],
    ["a pax size that differs", () => write([{ path: "package/a", data: "abc", pax: { size: "5" } }]), /pax size/],
    ["a pax record with no length", () => write([{ path: "P", type: "x", data: "bad" }, { path: "package/a" }]), /pax/],
    ["a pax length not in digits", () => write([{ path: "P", type: "x", data: "0x0c path=a\n" }]), /unreadable pax/],
    ["a pax length past its header", () => write([{ path: "P", type: "x", data: "99 path=a\n" }]), /unreadable pax/],
    ["a pax record with no newline", () => write([{ path: "P", type: "x", data: "10 path=a!" }]), /unreadable pax/],
    ["a pax record with no =", () => write([{ path: "P", type: "x", data: "9 pathaa\n" }]), /unreadable pax/],
    ["five pax headers in a row", () => write(Array<File>(5).fill({ path: "P", type: "x" })), /in a row/],
    ["a bad checksum", () => write(base, (t) => (t.writeUInt8(t[100]! ^ 1, 100), t)), /checksum/],
    ["a field that is not octal", () => write(base, (t) => (t.write("zz", 148), t)), /not octal/],
    ["a cut short entry", () => write([{ path: "package/a", data: Buffer.alloc(2000) }], cut), /cut short/],
    ["too many entries", () => write(Array.from({ length: 5_001 }, () => ({ path: "package/a" }))), /5000 entries/],
    ["one that unpacks past the cap", () => write([{ path: "package/a", data: Buffer.alloc(MAX_READ) }]), /unpacks/],
    ["a file over the budget", big, /more than 8000000 bytes/],
    ["a device", () => Promise.resolve("/dev/zero"), /not a regular file/],
    ["one npm's reader refuses", () => write(add({ path: "" })(base)), /npm's tar reader: .*path is required/],
  ])("refuses %s unread", async (_, make, reason) => {
    const file = await make();
    expect(() => checkPackage(file)).toThrow(reason);
  });

  it("refuses by npm's reading alone a header this reader reads apart", async () => {
    const moved = { path: "package/package.json", prefix: "package/dist", magic: "ustar\0xx" };
    const file = await write(add(moved)(base));
    PREFIXED.add("ustar\0xx");
    try {
      expect(checkPackage(file)).toEqual([
        expect.stringMatching(
          /^npm's tar reads entry \d+ as package\/package\.json 0 0 644, this script as package\/dist/,
        ),
      ]);
    } finally {
      PREFIXED.delete("ustar\0xx");
    }
  });

  it("finds an entry npm's reader skips", async () => {
    expect(await check(add({ path: "package/z", type: "Z" })(base))).toEqual([
      expect.stringMatching(/^npm's tar reads entry \d+ as package\/z ignored, this script as package\/z Z 0 644$/),
      'package/z: tar entry type "Z"',
    ]);
  });

  it("exits 1 listing every finding, and 2 on bad usage, an unreadable file or no npm reader", async () => {
    const file = await write([...base, { path: "package/.env" }, { path: "package/a.test.js" }]);
    const r = run([file]);
    expect([r.status, r.stdout.split("\n").length]).toEqual([1, 4]);
    expect(run([]).status).toBe(2);
    expect(run(["a.tgz", "b.tgz"]).status).toBe(2);
    expect(run([file, "--version="]).status).toBe(2);
    expect(run([join(dir, "missing.tgz")]).status).toBe(2);
    expect(run([join(ROOT, "package.json")]).status).toBe(2);
    const fake = join(dir, "fake-npm");
    await mkdir(fake);
    await writeFile(join(fake, "npm"), `#!/bin/sh\necho ${join(dir, "no-npm-here")}\n`, { mode: 0o755 });
    const noTar = run([await write(base)], { PATH: fake });
    expect([noTar.status, noTar.stderr]).toEqual([2, expect.stringMatching(/^npm's tar reader is not under /)]);
    const noNpm = run([await write(base)], { PATH: dir });
    expect([noNpm.status, noNpm.stderr]).toEqual([2, expect.stringMatching(/npm/)]);
  });
});
