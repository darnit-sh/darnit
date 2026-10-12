import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const OASDIFF_VERSION = "1.32.1";

// Taken from the release's checksums.txt and matched against GitHub's own asset digests, so a
// release changed after the fact can't swap the binary and its checksum together.
const SHA256: Record<string, string> = {
  "oasdiff_1.32.1_darwin_all.tar.gz": "e4d74b7e2dfb9d4819e7fc720c905ec86547e4637ac270a2b0187c0f1fb7187e",
  "oasdiff_1.32.1_linux_amd64.tar.gz": "7c8939fc49b75ee11fec66a5b83b37a2fca6aee109fed85013b1ba2ac2a1ee7f",
  "oasdiff_1.32.1_linux_arm64.tar.gz": "32fff58a120f75a723d6c2422444691c37fa6813fed61d23f53dbcb604b30f6d",
  "oasdiff_1.32.1_windows_amd64.tar.gz": "4d0758b32d454e6011e59db93884af1ca27ae2b212d990f36738ea5efb5d7f28",
  "oasdiff_1.32.1_windows_arm64.tar.gz": "7937f4506954676c495188b5c0a221019079801857fb7ba29dd2bc2a767cacab",
};

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
  const archive = await download(`${base}/${asset}`);
  const expected = SHA256[asset];
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
