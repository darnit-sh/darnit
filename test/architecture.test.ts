import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compare, parseAllowlist } from "../scripts/allowlist.js";
import { buildGraph, cycles, importsOf, readSources, type ImportGraph, type Sources } from "./import-graph.js";

/**
 * The module map: each group of files sits on a floor and imports only from lower floors. An island
 * imports floors up to its reach and is imported only from scripts/, which reach floor 3. `also` names
 * the groups on the same floor, or the island exceptions, a group may still import. Paths are files, or
 * folders ending in a slash; a file in none of them fails the test. Folders that do not exist yet (src/cli/,
 * src/vendors/ and the like) are where the map puts files as they move, so a moved file keeps its floor.
 */
type Group = { floor: number; reach: number; kind?: "island" | "scripts"; paths: string[]; also: string[] };
const at = (floor: number, paths: string[], ...also: string[]): Group => ({ floor, reach: floor - 1, paths, also });
const GROUPS: Record<string, Group> = {
  cli: at(4, ["src/cli.ts", "src/init.ts", "src/update.ts", "src/cli/"]),
  check: at(3, ["src/check.ts", "src/check/"]),
  fix: at(3, ["src/fix.ts", "src/plan.ts", "src/tests.ts", "src/fix/"], "check"),
  apply: at(3, ["src/packs/apply.ts"]),
  scan: at(2, ["src/scan/"], "records"),
  records: at(2, ["src/records/"]),
  git: at(2, ["src/git.ts", "src/git/"]),
  github: at(2, ["src/github.ts", "src/github/"]),
  versions: at(2, ["src/versions.ts"]),
  detect: at(1, ["src/detect.ts"]),
  vendors: at(1, ["src/vendors/"]),
  io: at(1, ["src/io/"]),
  output: at(1, ["src/output/"]),
  errors: at(0, ["src/refusal.ts", "src/errors.ts"]),
  corpus: { floor: NaN, reach: 2, kind: "island", paths: ["src/corpus/"], also: [] },
  // The map lets the fixture runner use the rule applier, so a pack runs in CI as it runs for a user.
  fixtures: { floor: NaN, reach: 2, kind: "island", paths: ["src/packs/fixtures.ts"], also: ["apply"] },
  scripts: { floor: NaN, reach: 3, kind: "scripts", paths: ["scripts/"], also: [] },
};

const ALLOWLIST = "scripts/allow/imports.tsv";

type Place = Group & { group: string };

function placeOf(file: string): Place | undefined {
  const inside = (path: string) => (path.endsWith("/") ? file.startsWith(path) : file === path);
  const entry = Object.entries(GROUPS).find(([, g]) => g.paths.some(inside));
  return entry && { ...entry[1], group: entry[0] };
}

/** Why an import from one place to another breaks the module map, or undefined when it does not. */
function breaks(from: Place, to: Place): string | undefined {
  if (from.group === to.group || from.also.includes(to.group)) return undefined;
  if (to.kind === "scripts") return "only scripts/ imports scripts/";
  if (to.kind === "island") return from.kind === "scripts" ? undefined : `only scripts/ imports the ${to.group} island`;
  if (to.floor <= from.reach) return undefined;
  const who = from.kind === "scripts" ? "scripts/" : `the ${from.group} island`;
  if (from.kind) return `${who} imports floor ${to.floor}, above floor ${from.reach}`;
  if (to.floor > from.floor) return `floor ${from.floor} imports floor ${to.floor}`;
  return `${from.group} imports ${to.group} on its own floor ${from.floor}`;
}

/** Files with no place in the map, and barrel files. */
function misplaced(tree: Sources): string[] {
  const problems: string[] = [];
  for (const file of tree.keys()) {
    if (!placeOf(file)) problems.push(`${file} has no floor: add it to GROUPS in test/architecture.test.ts`);
    if (/(^|\/)index\.[cm]?[jt]sx?$/.test(file)) problems.push(`${file} is a barrel file: import from the file that defines each name`);
  }
  return problems;
}

/**
 * Each import that breaks the module map, keyed as its allowlist line would name it. Every import between
 * the files of a cycle is on that cycle, so a cycle passes only while each of its imports is listed.
 */
function breaches({ graph, computed, loaders }: ImportGraph): Map<string, string> {
  const broken = new Map<string, string>();
  for (const key of computed) broken.set(key, "an import() or require() of a computed path, which this test cannot place");
  for (const key of loaders) broken.set(key, `a use of require or createRequire this test cannot follow; call require("path") or createRequire(url)("path")`);
  for (const [file, targets] of graph) {
    const from = placeOf(file);
    for (const target of targets) {
      const to = placeOf(target);
      const why = from && to && breaks(from, to);
      if (why) broken.set(`${file}\t${target}`, why);
    }
  }
  for (const set of cycles(graph)) {
    for (const [file, target] of set.flatMap((f) => [...graph.get(f)!].filter((t) => set.includes(t)).map((t) => [f, t]))) {
      const key = `${file}\t${target}`;
      broken.set(key, [broken.get(key), `in the cycle of ${set.join(", ")}`].filter(Boolean).join("; "));
    }
  }
  return broken;
}

/** Every breach not on the allowlist, and every allowlist line that no longer names a breach, each as "a -> b". */
function check(tree: Sources, list: string): string[] {
  const problems = misplaced(tree);
  const { lines, errors } = parseAllowlist(list, 2);
  problems.push(...errors.map((e) => `${ALLOWLIST}: ${e}`));
  const broken = breaches(buildGraph(tree, problems));
  const { missing, stale: gone } = compare(broken.keys(), lines);
  const shown = (key: string) => key.replaceAll("\t", " -> ");
  problems.push(...missing.map((key) => `${shown(key)}: ${broken.get(key)}`));
  problems.push(...gone.map((s) => `${ALLOWLIST}:${s.line}: "${shown(s.finding)}" no longer breaks the module map; remove its line`));
  return problems;
}

const sources = readSources();
const allowlist = readFileSync(ALLOWLIST, "utf8");

/** The failure for an allowlist line, named as "a -> b", whose break is gone. */
const stale = (key: string) =>
  `${ALLOWLIST}:${allowlist.split("\n").findIndex((l) => l.startsWith(`${key.replace(" -> ", "\t")}\t`)) + 1}: "${key}" no longer breaks the module map; remove its line`;

/** The problems with one line added to one file, or with the file created when it does not exist. */
function withLine(file: string, line: string): string[] {
  const changed = new Map(sources);
  changed.set(file, `${line}\n${sources.get(file) ?? ""}`);
  return check(changed, allowlist);
}

describe("the module map", () => {
  it("holds for src/ and scripts/, apart from the allowlist", () => {
    expect([...sources.keys()]).toEqual(expect.arrayContaining(["src/cli.ts", "src/scan/astgrep.ts", "scripts/e2e.ts"]));
    expect(check(sources, allowlist)).toEqual([]);
  });
});

const BREACHES: [string, string, string][] = [
  ["src/detect.ts", "./check.js", "src/detect.ts -> src/check.ts: floor 1 imports floor 3"],
  ["src/git.ts", "./records/load.js", "src/git.ts -> src/records/load.ts: git imports records on its own floor 2"],
  ["src/check.ts", "./fix.js", "src/check.ts -> src/fix.ts: check imports fix on its own floor 3"],
];
const FORMS: [string, (spec: string) => string][] = [
  ["a static import", (s) => `import { x } from "${s}";`],
  ["a type-only import", (s) => `import type { X } from "${s}";`],
  ["an inline type import", (s) => `import {\n  type X,\n  type Y,\n} from "${s}";`],
  ["a side effect import", (s) => `import "${s}";`],
  ["an export from", (s) => `export { x } from "${s}";`],
  ["an export star", (s) => `export * from "${s}";`],
  ["an export type from", (s) => `export type { X } from "${s}";`],
  ["a dynamic import()", (s) => `const m = await import("${s}");`],
  ["a dynamic import() of a plain template", (s) => `const m = await import(\`${s}\`);`],
  ["an export star as a namespace", (s) => `export * as ns from "${s}";`],
  ["an export type star as a namespace", (s) => `export type * as ns from "${s}";`],
  ["an export star as default", (s) => `export * as default from "${s}";`],
  ["an import equals require", (s) => `import x = require("${s}");`],
  ["a require() call", (s) => `const m = require("${s}");`],
  ["a createRequire call", (s) => `const m = createRequire(import.meta.url)("${s}");`],
  ["an import() type", (s) => `type M = typeof import("${s}");`],
  ["a reference path", (s) => `/// <reference path="${s}" />`],
  ["a module augmentation", (s) => `declare module "${s}" {}`],
];

describe("an import against the module map fails", () => {
  for (const [file, spec, failure] of BREACHES)
    for (const [form, write] of FORMS)
      it(`${failure.split(":")[0]} as ${form}`, () => {
        expect(withLine(file, write(spec))).toContainEqual(expect.stringContaining(failure));
      });

  it("fix importing the rule applier, which the map leaves out of fix until it moves into src/fix/", () => {
    expect(withLine("src/plan.ts", `import "./packs/apply.js";`)).toEqual(["src/plan.ts -> src/packs/apply.ts: fix imports apply on its own floor 3"]);
  });
});

describe("a cycle, a misplaced file or a stale allowlist line fails", () => {
  it("a new cycle between two floor-2 files", () => {
    expect(withLine("src/scan/values.ts", `import { findMentions } from "./mentions.js";`)).toEqual([
      "src/scan/mentions.ts -> src/scan/values.ts: in the cycle of src/scan/mentions.ts, src/scan/values.ts",
      "src/scan/values.ts -> src/scan/mentions.ts: in the cycle of src/scan/mentions.ts, src/scan/values.ts",
    ]);
  });

  it("a file importing itself", () => {
    expect(withLine("src/refusal.ts", `import "./refusal.js";`)).toEqual(["src/refusal.ts -> src/refusal.ts: in the cycle of src/refusal.ts"]);
  });

  it("a cycle through an allowlisted import", () => {
    expect(withLine("src/github.ts", `import { git } from "./git.js";`)).toEqual([
      "src/github.ts -> src/git.ts: github imports git on its own floor 2; in the cycle of src/git.ts, src/github.ts",
    ]);
  });

  it("a new cycle among the files of an allowlisted cycle, through an import the map allows", () => {
    expect(withLine("src/scan/clients.ts", `import { cleanEnv as _c } from "../detect.js";`)).toEqual([
      "src/scan/clients.ts -> src/detect.ts: in the cycle of src/detect.ts, src/records/schema.ts, src/scan/astgrep.ts, src/scan/clients.ts",
    ]);
  });

  it("a new file under src/ with no floor, and a barrel file", () => {
    expect(withLine("src/new.ts", `export const x = 1;`)).toEqual(["src/new.ts has no floor: add it to GROUPS in test/architecture.test.ts"]);
    expect(withLine("src/scan/index.ts", `export * from "./values.js";`)).toEqual(["src/scan/index.ts is a barrel file: import from the file that defines each name"]);
  });

  it("an allowlisted import removed from the code but left in the allowlist", () => {
    const gone = new Map(sources).set("src/git.ts", sources.get("src/git.ts")!.replace(/^import \{ envToken \}.*$/m, ""));
    expect(check(gone, allowlist)).toEqual([stale("src/git.ts -> src/github.ts")]);
  });

  it("an allowlisted cycle that changed", () => {
    const smaller = new Map(sources).set("src/detect.ts", sources.get("src/detect.ts")!.replace(/^import type \{ VendorClients \}.*$/m, ""));
    expect(check(smaller, allowlist)).toEqual([
      stale("src/detect.ts -> src/scan/clients.ts"),
      stale("src/scan/astgrep.ts -> src/detect.ts"),
    ]);
  });

  it("a malformed allowlist line", () => {
    const lines = allowlist.split("\n").length;
    expect(check(sources, `${allowlist}src/git.ts\tsrc/github.ts\n`)).toEqual([`${ALLOWLIST}: line ${lines} needs 2 fields and a reason, tab separated`]);
  });
});

describe("an import across islands and scripts/ fails", () => {
  it("an island imported from src/check.ts", () => {
    expect(withLine("src/check.ts", `import { covers } from "./corpus/candidates.js";`)).toEqual([
      "src/check.ts -> src/corpus/candidates.ts: only scripts/ imports the corpus island",
    ]);
    expect(withLine("src/check.ts", `import { runPackFixtures } from "./packs/fixtures.js";`)).toEqual([
      "src/check.ts -> src/packs/fixtures.ts: only scripts/ imports the fixtures island",
    ]);
  });

  it("scripts/ importing src/cli.ts, and src/ importing scripts/", () => {
    expect(withLine("scripts/corpus.ts", `import "../src/cli.js";`)).toEqual(["scripts/corpus.ts -> src/cli.ts: scripts/ imports floor 4, above floor 3"]);
    expect(withLine("src/refusal.ts", `import "../scripts/golden.js";`)).toContain("src/refusal.ts -> scripts/golden.ts: only scripts/ imports scripts/");
  });

  it("an island importing above floor 2, or another island", () => {
    expect(withLine("src/corpus/spec.ts", `import "../check.js";`)).toEqual(["src/corpus/spec.ts -> src/check.ts: the corpus island imports floor 3, above floor 2"]);
    expect(withLine("src/corpus/spec.ts", `import "../packs/fixtures.js";`)).toEqual(["src/corpus/spec.ts -> src/packs/fixtures.ts: only scripts/ imports the fixtures island"]);
  });

  it("an import it cannot follow", () => {
    const computed = (call: string) => `src/refusal.ts -> ${call}: an import() or require() of a computed path, which this test cannot place`;
    expect(withLine("src/refusal.ts", "const m = await import(`./${name}.js`);")).toEqual([computed("import(`./${name}.js`)")]);
    expect(withLine("src/refusal.ts", "const m = await import(name);")).toEqual([computed("import(name)")]);
    expect(withLine("src/refusal.ts", "const m = require(name);")).toEqual([computed("require(name)")]);
    expect(withLine("src/refusal.ts", "createRequire(import.meta.url)(name);")).toEqual([computed("createRequire(import.meta.url)(name)")]);
    expect(withLine("src/refusal.ts", "const req = require;")).toEqual([`src/refusal.ts -> req=require: a use of require or createRequire this test cannot follow; call require("path") or createRequire(url)("path")`]);
    expect(withLine("src/refusal.ts", `import "./missing.js";`)).toEqual([`src/refusal.ts imports "./missing.js", which is not a file under src/ or scripts/`]);
    expect(withLine("src/refusal.ts", `import "./missing.json";`)).toEqual([`src/refusal.ts imports "./missing.json", which is not a file under src/ or scripts/`]);
  });

  it("an import of a .js path that names a .tsx file", () => {
    const tsx = new Map(sources).set("src/scan/view.tsx", "export const v = 1;\n");
    tsx.set("src/refusal.ts", `import "./scan/view.js";\n${sources.get("src/refusal.ts")}`);
    expect(check(tsx, allowlist)).toEqual(["src/refusal.ts -> src/scan/view.tsx: floor 0 imports floor 2"]);
  });
});

describe("the computed require() in the rule applier", () => {
  it("is read, and named by the allowlist", () => {
    const apply = sources.get("src/packs/apply.ts")!;
    expect(importsOf("src/packs/apply.ts", apply)).toMatchObject({ computed: ["require(pkgPath)"], loaders: [`require=createRequire(import.meta.url)`, `createRequire(import.meta.url)`, `require.resolve("@ast-grep/cli/package.json")`] });
    expect(check(new Map(sources).set("src/packs/apply.ts", apply.replace("require(pkgPath)", "JSON.parse(pkgPath)")), allowlist)).toEqual([
      stale("src/packs/apply.ts -> require(pkgPath)"),
    ]);
  });

  it("does not cover a second call with the same text", () => {
    const sneak = `export function sneak(): unknown { const pkgPath = "../check.js"; return require(pkgPath); }`;
    expect(check(new Map(sources).set("src/packs/apply.ts", `${sources.get("src/packs/apply.ts")}\n${sneak}\n`), allowlist)).toEqual([
      "src/packs/apply.ts -> require(pkgPath)#2: an import() or require() of a computed path, which this test cannot place",
    ]);
  });
});

describe("what does not count as an import", () => {
  it("text that only looks like one, and imports of packages", () => {
    const lookAlikes = [
      `// import { x } from "./check.js";`,
      `/* export * from "./check.js"; */`,
      `const s = 'import { x } from "./check.js"';`,
      `import ts from "typescript";`,
      `import { join } from "node:path";`,
      `const r = /import\\("\\.\\/check\\.js"\\)|require\\("\\.\\/check\\.js"\\)/;`,
      "const t = `import(\"./check.js\")`;",
      `const { version } = createRequire(import.meta.url)("../package.json");`,
    ];
    expect(withLine("src/refusal.ts", lookAlikes.join("\n"))).toEqual([]);
  });

  it("imports the map allows: down a floor, scan to records, fix to check, an island to the applier", () => {
    const allowed = [
      ["src/cli.ts", `import "./refusal.js";`],
      ["src/scan/mentions.ts", `import type { Lang } from "../records/schema.js";`],
      ["src/plan.ts", `import type { Hit } from "./check.js";`],
      ["src/packs/fixtures.ts", `import "./apply.js";`],
      ["scripts/golden.ts", `import "../src/corpus/spec.js";`],
    ];
    for (const [file, line] of allowed) expect(withLine(file!, line!), `${file} ${line}`).toEqual([]);
  });
});
