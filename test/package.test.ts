import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SPECS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

type Lock = { packages: Record<string, { version?: string; dev?: boolean } & Partial<Record<(typeof SPECS)[number], Record<string, string>>>> };

const read = async (file: string): Promise<unknown> => JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
const exact = (spec: string) => /^\d+\.\d+\.\d+$/.test(spec);

// npx installs darnit without our lockfile, so a range here lets a new release of a dependency
// run in users' CI with no darnit release.
describe("runtime dependencies", () => {
  it("are exact versions, the ones package-lock.json installs", async () => {
    const { dependencies, overrides } = (await read("package.json")) as { dependencies: Record<string, string>; overrides?: unknown };
    const lock = (await read("package-lock.json")) as Lock;
    expect(Object.entries(dependencies).filter(([, spec]) => !exact(spec))).toEqual([]);
    // Users' installs ignore our overrides, so they would make the lockfile test something users never get.
    expect(overrides).toBeUndefined();
    expect(Object.fromEntries(Object.keys(dependencies).map((name) => [name, lock.packages[`node_modules/${name}`]?.version]))).toEqual(dependencies);
  });

  it("pull in only exact versions themselves", async () => {
    const lock = (await read("package-lock.json")) as Lock;
    const ranged = Object.entries(lock.packages)
      .filter(([, pkg]) => !pkg.dev)
      .flatMap(([path, pkg]) => SPECS.flatMap((kind) => Object.entries(pkg[kind] ?? {}).filter(([, spec]) => !exact(spec)).map(([name, spec]) => `${path} ${name}@${spec}`)));
    expect(ranged).toEqual([]);
  });
});

describe("package-lock.json", () => {
  it("is what npm ci accepts for package.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "darnit-lock-"));
    try {
      for (const f of ["package.json", "package-lock.json"]) await copyFile(new URL(`../${f}`, import.meta.url), join(dir, f));
      const r = spawnSync("npm", ["ci", "--dry-run", "--ignore-scripts", "--offline"], { cwd: dir, encoding: "utf8" });
      expect(r.stderr.split("\n").filter((l) => /Missing:|Invalid:/.test(l))).toEqual([]);
      expect(r.status).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // npm ci --omit=peer skips a package flagged peer, so a direct dependency must never be.
  it("flags no direct dependency as peer only", async () => {
    const pkg = (await read("package.json")) as Record<"dependencies" | "devDependencies", Record<string, string>>;
    const lock = (await read("package-lock.json")) as { packages: Record<string, { peer?: boolean }> };
    const direct = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)];
    expect(direct.filter((name) => lock.packages[`node_modules/${name}`]?.peer)).toEqual([]);
  });
});
