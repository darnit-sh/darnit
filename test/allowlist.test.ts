import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cloneFindings, compare, knipFindings, parseAllowlist, problems } from "../scripts/allowlist.js";
import { block, copy, edit, run, tempDirs } from "./allowlist-copy.js";

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
    expect(problems("list.tsv", "kept\twhy\nbare\n", 1, () => ["kept"])).toEqual([
      "list.tsv: line 2 needs 1 fields and a reason, tab separated",
    ]);
  });

  it("number the clones between two files, so another one between a listed pair is a finding of its own", () => {
    const place = (name: string, start: number) => ({ name: `/r/${name}`, start, end: start + 9 });
    const pair = (a: number, b: number) => ({ firstFile: place("b.ts", b), secondFile: place("a.ts", a) });
    const found = cloneFindings(
      { duplicates: [pair(40, 70), pair(5, 30), { firstFile: place("c.ts", 1), secondFile: place("a.ts", 1) }] },
      "/r",
    );
    expect([...found]).toEqual([
      ["a.ts\tb.ts\t#1", "lines a.ts:5-14 and b.ts:30-39"],
      ["a.ts\tb.ts\t#2", "lines a.ts:40-49 and b.ts:70-79"],
      ["a.ts\tc.ts\t#1", "lines a.ts:1-10 and c.ts:1-10"],
    ]);
  });

  it("key a member by its parent, so one cannot stand in for another of the same name", () => {
    const report = {
      issues: [
        {
          file: "src/k.ts",
          enumMembers: [
            { namespace: "Kind", name: "B" },
            { namespace: "Mode", name: "B" },
          ],
          owners: [],
        },
      ],
    };
    expect(knipFindings(report)).toEqual(["enumMembers\tsrc/k.ts\tKind.B", "enumMembers\tsrc/k.ts\tMode.B"]);
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
    expect(r.out).toMatch(
      /scripts\/allow\/unused\.tsv:\d+ is no longer found: exports\tsrc\/corpus\/oasdiff\.ts\tOASDIFF_VERSION/,
    );
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
    await writeFile(
      join(dir, "src/one.ts"),
      block((n) => n),
    );
    await writeFile(join(dir, "src/two.ts"), `// a copy\n${block((n) => n)}`);
    const r = run("duplicates", dir);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(
      /not in scripts\/allow\/duplicates\.tsv: src\/one\.ts\tsrc\/two\.ts\t#1 \(lines src\/one\.ts:1-\d+ and src\/two\.ts:2-\d+\)/,
    );
  });

  it("fails on the same block with every name changed", async () => {
    const dir = await copy();
    await writeFile(
      join(dir, "src/one.ts"),
      block((n) => n),
    );
    await writeFile(
      join(dir, "src/two.ts"),
      block((n) => `${n}Copy`),
    );
    const r = run("duplicates", dir);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(
      /not in scripts\/allow\/duplicates\.tsv: src\/one\.ts\tsrc\/two\.ts\t#1 \(lines src\/one\.ts:1-\d+ and src\/two\.ts:1-\d+\)/,
    );
  });

  it("keys a block by its files and place, so an edit above or inside a listed block changes nothing", async () => {
    const dir = await copy();
    for (const file of [
      "src/versions.ts",
      "src/scan/astgrep.ts",
      "scripts/accounting.ts",
      "scripts/corpus.ts",
      "scripts/backfill-removals.ts",
    ]) {
      await writeFile(
        join(dir, file),
        `// A note on what this module reads.\n\n${await readFile(join(dir, file), "utf8")}`,
      );
    }
    const astgrep = join(dir, "src/scan/astgrep.ts");
    await edit(
      astgrep,
      "    while (lo < hi) {\n      const mid = (lo + hi) >> 1;",
      "    while (lo < hi) {\n      // halve the range\n      const mid = (lo + hi)>>1;",
    );
    await edit(
      astgrep,
      "if (starts[mid]! < start) lo = mid + 1;",
      "if (starts[mid]! < start) lo = mid + 1; // still below",
    );
    await edit(join(dir, "scripts/corpus.ts"), "import { loadRecords } from", "import { loadRecords, PACKS_DIR } from");
    const renamed = (await readFile(astgrep, "utf8")).replace(/let \[lo, hi\][\s\S]*?starts\[lo\]! < end;/, (m) =>
      m.replace(/\blo\b/g, "low"),
    );
    expect(renamed).toContain("let [low, hi]");
    await writeFile(astgrep, renamed);
    expect(run("duplicates", dir)).toMatchObject({ status: 0 });
  });

  it("fails on a line left after its finding is gone", async () => {
    const dir = await copy();
    await appendFile(join(dir, "scripts/allow/duplicates.tsv"), "src/a.ts\tsrc/b.ts\t#1\tonce copied\n");
    const r = run("duplicates", dir);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/scripts\/allow\/duplicates\.tsv:\d+ is no longer found: src\/a\.ts\tsrc\/b\.ts\t#1;/);
  });
});

describe("what knip cannot see, and members of the same name", () => {
  it("keeps an unseen line while its file declares the name, and reports it once the code is gone", async () => {
    const dir = await copy();
    await edit(join(dir, "src/git.ts"), "export const deleteBranch = ", "const removedBranch = ");
    const r = run("unused", dir);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/scripts\/allow\/unused\.tsv:\d+ is no longer found: unseen\tsrc\/git\.ts\tdeleteBranch/);
    expect(r.out).not.toContain("\tswitchTo");
  });

  it("does not count an inner declaration of the same name, so removing the exported add or commit is seen", async () => {
    const dir = await copy();
    const git = join(dir, "src/git.ts");
    await edit(
      git,
      'export const add = (root: string, files: readonly string[]) => git(root, ["add", "--", ...files]);\n',
      "",
    );
    await writeFile(
      git,
      (await readFile(git, "utf8")).replace(/\/\*\* Commits as the configured user[\s\S]*?\n}\n/, ""),
    );
    const r = run("unused", dir);
    expect(r.out).toMatch(/is no longer found: unseen\tsrc\/git\.ts\tadd;/);
    expect(r.out).toMatch(/is no longer found: unseen\tsrc\/git\.ts\tcommit;/);
    expect(r.out).not.toMatch(/\t(switchTo|position|deleteBranch|currentBranch);/);
  });

  it("reports a name once it is used again: imported, read from a namespace import, or called in its file", async () => {
    const dir = await copy();
    await appendFile(
      join(dir, "src/versions.ts"),
      '\nimport { switchTo } from "./git.js";\nexport const back = switchTo;\n',
    );
    await appendFile(join(dir, "src/fix.ts"), "\nexport const drop = g.deleteBranch;\n");
    await appendFile(join(dir, "src/git.ts"), "\nexport const where = (root: string) => position(root);\n");
    const r = run("unused", dir);
    for (const name of ["switchTo", "deleteBranch", "position", "currentBranch"])
      expect(r.out).toMatch(new RegExp(`is no longer found: unseen\\tsrc/git\\.ts\\t${name};`));
    expect(r.out).not.toMatch(/\t(add|commit);/);
  });

  it("keeps a name whose only user is itself unused and gone", async () => {
    const dir = await copy();
    const git = join(dir, "src/git.ts");
    await writeFile(git, (await readFile(git, "utf8")).replace(/\/\*\* Where to come back to[\s\S]*?\n}\n/, ""));
    const r = run("unused", dir);
    expect(r.out).toMatch(/is no longer found: unseen\tsrc\/git\.ts\tposition;/);
    expect(r.out).not.toContain("\tcurrentBranch;");
  });
});

describe("knip's findings", () => {
  it("tells apart enum members of the same name", async () => {
    const dir = await copy();
    await writeFile(join(dir, "src/kinds.ts"), "export enum Kind { A, B }\nexport enum Mode { A, B }\n");
    await appendFile(
      join(dir, "src/versions.ts"),
      '\nimport { Kind, Mode } from "./kinds.js";\nexport const kinds = [Kind.A, Mode.A];\n',
    );
    await appendFile(
      join(dir, "scripts/allow/unused.tsv"),
      "exports\tsrc/versions.ts\tkinds\ttest\nenumMembers\tsrc/kinds.ts\tMode.B\ttest\n",
    );
    const r = run("unused", dir);
    expect(r.status).toBe(1);
    expect(r.out.split("\n").filter((l) => l.startsWith("not in") || l.includes("no longer found"))).toEqual([
      "not in scripts/allow/unused.tsv: enumMembers\tsrc/kinds.ts\tKind.B; remove it, or add the line with the reason it stays",
    ]);
  });
});

describe("the tools as run from npm run knip and npm run duplicates", () => {
  it("finds what git's global and info excludes and a .jscpd.json of the folder's own would hide", async () => {
    const dir = await copy();
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const home = await mkdtemp(join(tmpdir(), "darnit-allowlist-home-"));
    tempDirs.push(home);
    await writeFile(join(home, "ignore"), "orphan.ts\ntwo.ts\n");
    await writeFile(join(home, ".gitconfig"), `[core]\n\texcludesFile = ${join(home, "ignore")}\n`);
    await writeFile(join(dir, ".git/info/exclude"), "src/orphan.ts\nsrc/two.ts\n");
    await writeFile(join(dir, ".jscpd.json"), '{ "ignore": ["**/two.ts"], "minTokens": 5000 }\n');
    await writeFile(join(dir, "src/orphan.ts"), "export const orphan = 1;\n");
    await writeFile(
      join(dir, "src/one.ts"),
      block((n) => n),
    );
    await writeFile(
      join(dir, "src/two.ts"),
      block((n) => n),
    );
    const env = Object.fromEntries(
      Object.entries({ ...process.env, HOME: home }).filter(([k]) => k !== "GIT_CONFIG_GLOBAL"),
    );
    expect(run("unused", dir, env).out).toContain("not in scripts/allow/unused.tsv: files\tsrc/orphan.ts");
    expect(run("duplicates", dir, env).out).toMatch(
      /not in scripts\/allow\/duplicates\.tsv: src\/one\.ts\tsrc\/two\.ts\t#1 \(lines src\/one\.ts:1-\d+ and src\/two\.ts:1-\d+\)/,
    );
  });
});
