import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkPackage, MAX_READ, MAX_UNPACKED } from "../scripts/check-package.js";

const ROOT = join(import.meta.dirname, "..");
const tsx = join(ROOT, "node_modules", ".bin", "tsx");
const { version: VERSION } = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as { version: string };
type File = { path: string; data?: string | Buffer; type?: string; link?: string; pax?: Record<string, string> };

// A tar writer that can write what npm never would: links, escaping paths, a path only a pax header holds.
const field = (n: number, width: number) => `${n.toString(8).padStart(width - 1, "0")}\0`;
const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc(-b.length & 511)]);
function header(f: File, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(f.path, 0, 100);
  h.write(field(0o644, 8), 100);
  h.write(field(size, 12), 124);
  h.write(`${" ".repeat(8)}${f.type ?? "0"}`, 148);
  h.write(f.link ?? "", 157, 100);
  h.write("ustar\x0000", 257);
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
function tar(files: File[]): Buffer {
  const blocks = files.flatMap((f) => {
    const data = Buffer.from(f.data ?? "");
    const ext = Buffer.from(paxData(f.pax ?? {}));
    const pax = f.pax ? [header({ path: "PaxHeader", type: "x" }, ext.length), pad(ext)] : [];
    return [...pax, header(f, data.length), pad(data)];
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

let dir: string;
let base: File[];
let count = 0;
const write = async (files: File[]) => {
  const file = join(dir, `${++count}.tgz`);
  await writeFile(file, tar(files));
  return file;
};
const check = async (files: File[], version?: string) => checkPackage(await write(files), { version });
const run = (args: string[]) => spawnSync(tsx, ["scripts/check-package.ts", ...args], { cwd: ROOT, encoding: "utf8" });
const npm = (...args: string[]) => spawnSync("npm", args, { cwd: ROOT, encoding: "utf8" }).status;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "darnit-package-"));
  const records = (await readdir(join(ROOT, "packs"), { recursive: true, withFileTypes: true }))
    .filter((d) => d.isFile())
    .map((d) => relative(ROOT, join(d.parentPath, d.name)))
    .filter((p) => /\/change\.json$|\/rules\//.test(p));
  base = [
    { path: "package/package.json", data: await readFile(join(ROOT, "package.json")) },
    { path: "package/dist/cli.js", data: "#!/usr/bin/env node\n" },
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

  it("passes the records as the checkout holds them", async () => {
    expect(await check(base, VERSION)).toEqual([]);
  });

  const add =
    (...extra: File[]) =>
    (b: File[]) => [...b, ...extra];
  const ok = { path: "package/dist/ok.js", pax: { path: "package/.env" } };
  const record = () => base.find((f) => f.path.endsWith("/change.json"))!.path;
  it.each<[string, (b: File[]) => File[], RegExp]>([
    ["an extra .env", add({ path: "package/dist/.env", data: "KEY=1" }), /dist\/\.env: a dotfile/],
    ["an env file by another name", add({ path: "package/dist/prod.env" }), /prod\.env: an env file/],
    ["a test file", add({ path: "package/dist/cli.test.js" }), /cli\.test\.js: a test file/],
    ["a source map", add({ path: "package/dist/cli.js.map" }), /cli\.js\.map: a source map/],
    ["a key", add({ path: "package/packs/x/rules/id_rsa" }), /id_rsa: named like a key/],
    ["a credentials file", add({ path: "package/dist/credentials.json" }), /credentials\.json: named like a key/],
    ["a file outside files", add({ path: "package/src/cli.ts" }), /src\/cli\.ts: not in package\.json/],
    ["a changed record", (b) => b.map((f) => (f.path === record() ? { ...f, data: "{}" } : f)), /differs from/],
    ["a missing record", (b) => b.filter((f) => f.path !== record()), /in the checkout but not in the tarball/],
    ["a symlink", add({ path: "package/dist/x.js", type: "2", link: "/etc/passwd" }), /symlink to \/etc/],
    ["a hard link", add({ path: "package/dist/x.js", type: "1", link: "package/dist/cli.js" }), /hard link/],
    ["a device", add({ path: "package/dist/x", type: "3" }), /package\/dist\/x: a device/],
    ["a ../ path", add({ path: "package/../evil.js" }), /evil\.js: outside package\//],
    ["an absolute path", add({ path: "/package/evil.js" }), /evil\.js: outside package\//],
    ["a backslash path", add({ path: "package/..\\evil.js" }), /evil\.js: outside package\//],
    // The first pax size must reach the file, not the second pax header.
    ["a path in a pax header", add({ path: "P", type: "x", data: paxData({ size: "0" }) }, ok), /\.env/],
    ["a GNU long name", add({ path: "L", type: "L", data: "package/.npmrc" }, { path: "package/a" }), /\.npmrc: a dot/],
    ["a missing bin", (b) => b.filter((f) => f.path !== "package/dist/cli.js"), /bin dist\/cli\.js is not in/],
    [
      "too many entries",
      add(...Array.from({ length: 5_000 }, (_, i) => ({ path: `package/dist/${i}.js` }))),
      /5000 entries/,
    ],
    ["over the size limit", add({ path: "package/dist/a.js", data: Buffer.alloc(MAX_UNPACKED) }), /more than/],
  ])("finds %s", async (_, breach, finding) => {
    expect(await check(breach(base), VERSION)).toEqual([expect.stringMatching(finding)]);
  });

  it("finds a wrong version", async () => {
    expect(await check(base, "9.9.9")).toEqual([`package/package.json: version ${VERSION}, expected 9.9.9`]);
  });

  it("stops reading a tarball that unpacks past its cap, and says so", async () => {
    const huge = [...base, { path: "package/dist/a.js", data: Buffer.alloc(MAX_READ) }];
    expect(await check(huge)).toEqual([expect.stringMatching(`unpacks to more than ${MAX_READ} bytes`)]);
  });

  it("exits 1 listing every finding, and 2 on bad usage or an unreadable file", async () => {
    const r = run([await write([...base, { path: "package/.env" }, { path: "package/a.test.js" }])]);
    expect([r.status, r.stdout.split("\n").length]).toEqual([1, 4]);
    expect(run([]).status).toBe(2);
    expect(run(["a.tgz", "b.tgz"]).status).toBe(2);
    expect(run([join(dir, "missing.tgz")]).status).toBe(2);
    expect(run([join(ROOT, "package.json")]).status).toBe(2);
  });
});
