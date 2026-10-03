import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const OASDIFF_VERSION = "1.32.1";

export function assetName(platform = process.platform, arch = process.arch): string {
  const cpu = arch === "arm64" ? "arm64" : "amd64";
  const os = platform === "darwin" ? "darwin_all" : platform === "win32" ? `windows_${cpu}` : `linux_${cpu}`;
  return `oasdiff_${OASDIFF_VERSION}_${os}.tar.gz`;
}

const exists = (p: string) => access(p).then(() => true, () => false);

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${url} (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** OASDIFF env, then PATH, then a pinned release downloaded once into ~/.cache/darnit. */
export async function oasdiffBinary(): Promise<string> {
  if (process.env.OASDIFF) return process.env.OASDIFF;
  const onPath = await exec("oasdiff", ["--version"]).then(() => true, () => false);
  if (onPath) return "oasdiff";

  const dir = join(homedir(), ".cache", "darnit", `oasdiff-${OASDIFF_VERSION}`);
  const bin = join(dir, process.platform === "win32" ? "oasdiff.exe" : "oasdiff");
  if (await exists(bin)) return bin;

  const asset = assetName();
  const base = `https://github.com/oasdiff/oasdiff/releases/download/v${OASDIFF_VERSION}`;
  const [archive, checksums] = await Promise.all([download(`${base}/${asset}`), download(`${base}/checksums.txt`)]);
  const expected = checksums.toString().split("\n").find((l) => l.endsWith(asset))?.split(/\s+/)[0];
  const actual = createHash("sha256").update(archive).digest("hex");
  if (!expected || expected !== actual) throw new Error(`checksum mismatch for ${asset}`);

  await mkdir(dir, { recursive: true });
  const file = join(dir, asset);
  await writeFile(file, archive);
  await exec("tar", ["-xzf", file, "-C", dir]);
  await chmod(bin, 0o755);
  return bin;
}

export type ChangeEntry = {
  id: string;
  /** 1 info, 2 warning, 3 error, as oasdiff grades them. */
  level: 1 | 2 | 3;
  text: string;
  operation?: string;
  operationId?: string;
  path?: string;
  fingerprint?: string;
};

export async function changelog(oldSpec: string, newSpec: string): Promise<ChangeEntry[]> {
  const bin = await oasdiffBinary();
  const { stdout } = await exec(bin, ["changelog", oldSpec, newSpec, "-f", "json"], { maxBuffer: 256 * 1024 * 1024 });
  const text = stdout.trim();
  return text ? (JSON.parse(text) as ChangeEntry[]) : [];
}
