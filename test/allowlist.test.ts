import { spawnSync } from "node:child_process";
import { appendFile, cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compare, parseAllowlist } from "../scripts/allowlist.js";

const ROOT = join(import.meta.dirname, "..");
const tsx = join(ROOT, "node_modules", ".bin", "tsx");
const COPIED = ["src", "scripts", "test", ".gitignore", "package.json", "knip.json", "tsconfig.json", "vitest.config.ts", "eslint.config.js"];

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** This repository's code and configs in a temporary folder, with its node_modules linked in. */
async function copy() {
  const dir = await mkdtemp(join(tmpdir(), "darnit-allowlist-"));
  tempDirs.push(dir);
  await Promise.all(COPIED.map((p) => cp(join(ROOT, p), join(dir, p), { recursive: true })));
  await symlink(join(ROOT, "node_modules"), join(dir, "node_modules"));
  return dir;
}

const run = (kind: "unused" | "duplicates", root = ROOT) => {
  const r = spawnSync(tsx, ["scripts/allowlist.ts", kind, "--root", root], { cwd: ROOT, encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
};

const edit = async (file: string, from: string, to: string) => {
  const text = await readFile(file, "utf8");
  expect(text).toContain(from);
  await writeFile(file, text.replace(from, to));
};

/** A 60 line function; `rename` swaps every name in it, as a copy with variables renamed would. */
function block(rename: (name: string) => string) {
  const body = Array.from({ length: 57 }, (_, i) => `  const ${rename(`part${i}`)} = ${rename("input")}.slice(${i}, ${i + 3}).trim() + ${rename("sep")};`);
  return [`export function ${rename("pieces")}(${rename("input")}: string, ${rename("sep")}: string): number {`, ...body, `  return ${rename("part0")}.length;`, "}", ""].join("\n");
}

describe("the allowlists", () => {
  it("name exactly what knip and jscpd find in this repository", () => {
    for (const kind of ["unused", "duplicates"] as const) expect(run(kind), kind).toMatchObject({ status: 0 });
  });

  it("need a reason on every line, and name each finding once", () => {
    expect(parseAllowlist("# comment\n\na\tb\twhy\n", 2).errors).toEqual([]);
    expect(parseAllowlist("a\tb\n", 2).errors).toEqual(["line 1 needs 2 fields and a reason, tab separated"]);
    expect(parseAllowlist("a\tb\t \n", 2).errors).toEqual(["line 1 needs 2 fields and a reason, tab separated"]);
    expect(parseAllowlist("a\tb\twhy\na\tb\tagain\n", 2).errors).toEqual(["line 2 repeats line 1"]);
  });

  it("report a finding the list lacks and a line whose finding is gone", () => {
    const { lines } = parseAllowlist("kept\twhy\ngone\twhy\n", 1);
    expect(compare(["kept", "new"], lines)).toEqual({ missing: ["new"], stale: [{ line: 2, finding: "gone" }] });
  });
});

describe("npm run knip", () => {
  it("fails on a new unused export in a src file", async () => {
    const dir = await copy();
    await appendFile(join(dir, "src/versions.ts"), "\nexport const leftOver = 1;\n");
    const r = run("unused", dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain("not in scripts/allow/unused.tsv: exports\tsrc/versions.ts\tleftOver");
  });

  it("fails on a new unused file", async () => {
    const dir = await copy();
    await writeFile(join(dir, "src/orphan.ts"), "export const orphan = 1;\n");
    const r = run("unused", dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain("not in scripts/allow/unused.tsv: files\tsrc/orphan.ts\tsrc/orphan.ts");
  });

  it("fails on a new unused dependency in package.json", async () => {
    const dir = await copy();
    await edit(join(dir, "package.json"), `"commander": "15.0.0",`, `"commander": "15.0.0",\n    "left-pad": "1.3.0",`);
    const r = run("unused", dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain("not in scripts/allow/unused.tsv: dependencies\tpackage.json\tleft-pad");
  });

  it("fails on a line left after its finding is gone, and on a finding the list lacks", async () => {
    const dir = await copy();
    await edit(join(dir, "src/corpus/oasdiff.ts"), "export const OASDIFF_VERSION", "const OASDIFF_VERSION");
    await edit(join(dir, "scripts/allow/unused.tsv"), "types\tsrc/detect.ts\tVendor\t", "#");
    const r = run("unused", dir);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/scripts\/allow\/unused\.tsv:\d+ is no longer found: exports\tsrc\/corpus\/oasdiff\.ts\tOASDIFF_VERSION/);
    expect(r.out).toContain("not in scripts/allow/unused.tsv: types\tsrc/detect.ts\tVendor");
  });

  it("fails on a configuration hint, which knip leaves out of its findings", async () => {
    const dir = await copy();
    await edit(join(dir, "knip.json"), `"test/helpers.ts"`, `"test/helpers.ts", "test/no-credentials.ts"`);
    const r = run("unused", dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain("knip exited 1; run npx knip to see why");
  });
});

describe("npm run duplicates", () => {
  it("fails on a 60 line block copied between two src files", async () => {
    const dir = await copy();
    await writeFile(join(dir, "src/one.ts"), block((n) => n));
    await writeFile(join(dir, "src/two.ts"), `// a copy\n${block((n) => n)}`);
    const r = run("duplicates", dir);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/not in scripts\/allow\/duplicates\.tsv: src\/one\.ts:1-\d+\tsrc\/two\.ts:2-\d+/);
  });

  it("fails on the same block with every name changed", async () => {
    const dir = await copy();
    await writeFile(join(dir, "src/one.ts"), block((n) => n));
    await writeFile(join(dir, "src/two.ts"), block((n) => `${n}Copy`));
    const r = run("duplicates", dir);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/not in scripts\/allow\/duplicates\.tsv: src\/one\.ts:1-\d+\tsrc\/two\.ts:1-\d+/);
  });

  it("fails on a line left after its finding is gone", async () => {
    const dir = await copy();
    await appendFile(join(dir, "scripts/allow/duplicates.tsv"), "src/a.ts:1-60\tsrc/b.ts:1-60\tonce copied\n");
    const r = run("duplicates", dir);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/scripts\/allow\/duplicates\.tsv:\d+ is no longer found: src\/a\.ts:1-60\tsrc\/b\.ts:1-60/);
  });
});
