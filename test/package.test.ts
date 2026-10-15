import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SPECS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

type Lock = { packages: Record<string, { version?: string; dev?: boolean } & Partial<Record<(typeof SPECS)[number], Record<string, string>>>> };

const read = async (file: string): Promise<unknown> => JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
const exact = (spec: string) => /^\d+\.\d+\.\d+$/.test(spec);

// npx installs darnit without our lockfile, so a range here lets a new release of a dependency
// run in users' CI with no darnit release.
describe("runtime dependencies", () => {
  it("are exact versions, the ones package-lock.json installs", async () => {
    const { dependencies } = (await read("package.json")) as { dependencies: Record<string, string> };
    const lock = (await read("package-lock.json")) as Lock;
    expect(Object.entries(dependencies).filter(([, spec]) => !exact(spec))).toEqual([]);
    expect(Object.fromEntries(Object.keys(dependencies).map((name) => [name, lock.packages[`node_modules/${name}`]?.version]))).toEqual(dependencies);
  });

  it("pull in only exact versions themselves", async () => {
    const lock = (await read("package-lock.json")) as Lock;
    const ranged = Object.entries(lock.packages)
      .filter(([path, pkg]) => path && !pkg.dev)
      .flatMap(([path, pkg]) => SPECS.flatMap((kind) => Object.entries(pkg[kind] ?? {}).filter(([, spec]) => !exact(spec)).map(([name, spec]) => `${path} ${name}@${spec}`)));
    expect(ranged).toEqual([]);
  });
});
