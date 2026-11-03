import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The module map: each group of files sits on a floor and imports only from lower floors. An island
 * imports floors up to its reach and is imported only from scripts/, which reach floor 3. `also` names
 * the groups on the same floor, or the island exceptions, a group may still import. Paths are files, or
 * folders ending in a slash; a file in none of them fails the test.
 */
type Group = { floor: number; reach: number; kind?: "island" | "scripts"; paths: string[]; also: string[] };
const at = (floor: number, paths: string[], ...also: string[]): Group => ({ floor, reach: floor - 1, paths, also });
const GROUPS: Record<string, Group> = {
  cli: at(4, ["src/cli.ts", "src/init.ts", "src/update.ts", "src/cli/"]),
  check: at(3, ["src/check.ts", "src/check/"]),
  fix: at(3, ["src/fix.ts", "src/plan.ts", "src/tests.ts", "src/fix/"], "check", "apply"),
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
  fixtures: { floor: NaN, reach: 2, kind: "island", paths: ["src/packs/fixtures.ts"], also: ["apply"] },
  scripts: { floor: NaN, reach: 3, kind: "scripts", paths: ["scripts/"], also: [] },
};

const ALLOWLIST = "test/architecture-allowlist.txt";
const CODE = /\.[cm]?[jt]sx?$/;

type Place = Group & { group: string };
type Sources = Map<string, string>;

function placeOf(file: string): Place | undefined {
  const inside = (path: string) => (path.endsWith("/") ? file.startsWith(path) : file === path);
  const entry = Object.entries(GROUPS).find(([, g]) => g.paths.some(inside));
  return entry && { ...entry[1], group: entry[0] };
}

/** Every file under src/ and every code file under scripts/, by path from the repository root. */
function readSources(): Sources {
  const sources: Sources = new Map();
  for (const dir of ["src", "scripts"]) {
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      const file = posix.relative(".", `${entry.parentPath}/${entry.name}`.split("\\").join("/"));
      if (!entry.isDirectory() && (dir === "src" || CODE.test(file))) sources.set(file, readFileSync(file, "utf8"));
    }
  }
  return sources;
}

/** The file an import specifier names, with .js read as .ts; undefined for a package or a builtin. */
function resolveSpecifier(file: string, specifier: string, sources: Sources): string | undefined {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return undefined;
  const path = posix.join(posix.dirname(file), specifier);
  const asTs = path.replace(/\.([cm]?)js(x?)$/, ".$1ts$2");
  return sources.has(asTs) ? asTs : path;
}

/** Static imports, `import type`, `export ... from`, side effect imports and import() with a literal. */
function buildGraph(sources: Sources, problems: string[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const [file, text] of sources) {
    const targets = new Set<string>();
    graph.set(file, targets);
    if (!CODE.test(file)) continue;
    if (/\bimport\s*\(\s*(?:[^\s"'`)]|`[^`]*\$\{)/.test(text)) problems.push(`${file} has an import() of a computed path, which this test cannot place`);
    for (const { fileName } of ts.preProcessFile(text, true, true).importedFiles) {
      const target = resolveSpecifier(file, fileName, sources);
      if (target === undefined) continue;
      if (sources.has(target)) targets.add(target);
      else problems.push(`${file} imports "${fileName}", which is not a file under src/ or scripts/`);
    }
  }
  return graph;
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

/** The strongly connected sets of files with more than one file or an import of itself (Tarjan). */
function cycles(graph: Map<string, Set<string>>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const found: string[][] = [];
  const visit = (file: string): void => {
    index.set(file, index.size);
    low.set(file, index.get(file)!);
    stack.push(file);
    for (const next of graph.get(file) ?? []) {
      if (!index.has(next)) visit(next);
      if (stack.includes(next)) low.set(file, Math.min(low.get(file)!, low.get(next)!));
    }
    if (low.get(file) !== index.get(file)) return;
    const set = stack.splice(stack.indexOf(file));
    if (set.length > 1 || graph.get(file)?.has(file)) found.push(set.sort());
  };
  for (const file of [...graph.keys()].sort()) if (!index.has(file)) visit(file);
  return found;
}

/** Allowlist lines: `a -> b: reason` for an import, `cycle a b c: reason` for a cycle's files. */
function readAllowlist(text: string, problems: string[]): Set<string> {
  const allowed = new Set<string>();
  for (const line of text.split("\n").map((l) => l.trim())) {
    if (!line || line.startsWith("#")) continue;
    const match = /^(cycle(?: \S+)+|\S+ -> \S+): \S/.exec(line);
    if (match) allowed.add(match[1]!);
    else problems.push(`${ALLOWLIST}: "${line}" is not "a -> b: reason" or "cycle a b ...: reason"`);
  }
  return allowed;
}

/** Files with no place in the map, and barrel files. */
function misplaced(sources: Sources): string[] {
  const problems: string[] = [];
  for (const file of sources.keys()) {
    if (!placeOf(file)) problems.push(`${file} has no floor: add it to GROUPS in test/architecture.test.ts`);
    if (/(^|\/)index\.[cm]?[jt]sx?$/.test(file)) problems.push(`${file} is a barrel file: import from the file that defines each name`);
  }
  return problems;
}

/** Each import and cycle that breaks the module map, keyed as its allowlist line would name it. */
function breaches(graph: Map<string, Set<string>>): Map<string, string> {
  const broken = new Map<string, string>();
  for (const [file, targets] of graph) {
    const from = placeOf(file);
    for (const target of targets) {
      const to = placeOf(target);
      const why = from && to && breaks(from, to);
      if (why) broken.set(`${file} -> ${target}`, why);
    }
  }
  for (const set of cycles(graph)) broken.set(`cycle ${set.join(" ")}`, "a cycle, which the module map forbids anywhere");
  return broken;
}

/** Every breach not on the allowlist, and every allowlist line that no longer names a breach. */
function check(sources: Sources, allowlist: string): string[] {
  const problems = misplaced(sources);
  const allowed = readAllowlist(allowlist, problems);
  const broken = breaches(buildGraph(sources, problems));
  for (const [key, why] of broken) if (!allowed.has(key)) problems.push(`${key}: ${why}`);
  for (const key of allowed) if (!broken.has(key)) problems.push(`${ALLOWLIST}: "${key}" no longer breaks the module map; remove its line`);
  return problems;
}

const sources = readSources();
const allowlist = readFileSync(ALLOWLIST, "utf8");

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
];

describe("an import against the module map fails", () => {
  for (const [file, spec, failure] of BREACHES)
    for (const [form, write] of FORMS)
      it(`${failure.split(":")[0]} as ${form}`, () => {
        expect(withLine(file, write(spec))).toContain(failure);
      });
});

describe("a cycle, a misplaced file or a stale allowlist line fails", () => {
  it("a new cycle between two floor-2 files", () => {
    expect(withLine("src/scan/values.ts", `import { findMentions } from "./mentions.js";`)).toEqual([
      "cycle src/scan/mentions.ts src/scan/values.ts: a cycle, which the module map forbids anywhere",
    ]);
  });

  it("a file importing itself", () => {
    expect(withLine("src/refusal.ts", `import "./refusal.js";`)).toEqual(["cycle src/refusal.ts: a cycle, which the module map forbids anywhere"]);
  });

  it("a cycle through an allowlisted import", () => {
    expect(withLine("src/github.ts", `import { git } from "./git.js";`)).toEqual([
      "src/github.ts -> src/git.ts: github imports git on its own floor 2",
      "cycle src/git.ts src/github.ts: a cycle, which the module map forbids anywhere",
    ]);
  });

  it("a new file under src/ with no floor, and a barrel file", () => {
    expect(withLine("src/new.ts", `export const x = 1;`)).toEqual(["src/new.ts has no floor: add it to GROUPS in test/architecture.test.ts"]);
    expect(withLine("src/scan/index.ts", `export * from "./values.js";`)).toEqual(["src/scan/index.ts is a barrel file: import from the file that defines each name"]);
  });

  it("an allowlisted import removed from the code but left in the allowlist", () => {
    const gone = new Map(sources).set("src/git.ts", sources.get("src/git.ts")!.replace(/^import \{ envToken \}.*$/m, ""));
    expect(check(gone, allowlist)).toEqual([`${ALLOWLIST}: "src/git.ts -> src/github.ts" no longer breaks the module map; remove its line`]);
  });

  it("an allowlisted cycle that changed", () => {
    const smaller = new Map(sources).set("src/detect.ts", sources.get("src/detect.ts")!.replace(/^import type \{ VendorClients \}.*$/m, ""));
    expect(check(smaller, allowlist)).toEqual([
      "cycle src/records/schema.ts src/scan/astgrep.ts src/scan/clients.ts: a cycle, which the module map forbids anywhere",
      `${ALLOWLIST}: "src/detect.ts -> src/scan/clients.ts" no longer breaks the module map; remove its line`,
      `${ALLOWLIST}: "cycle src/detect.ts src/records/schema.ts src/scan/astgrep.ts src/scan/clients.ts" no longer breaks the module map; remove its line`,
    ]);
  });

  it("a malformed allowlist line", () => {
    expect(check(sources, `${allowlist}\nsrc/git.ts -> src/github.ts\n`)).toEqual([`${ALLOWLIST}: "src/git.ts -> src/github.ts" is not "a -> b: reason" or "cycle a b ...: reason"`]);
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
    expect(withLine("src/refusal.ts", "const m = await import(`./${name}.js`);")).toEqual(["src/refusal.ts has an import() of a computed path, which this test cannot place"]);
    expect(withLine("src/refusal.ts", "const m = await import(name);")).toEqual(["src/refusal.ts has an import() of a computed path, which this test cannot place"]);
    expect(withLine("src/refusal.ts", `import "./missing.js";`)).toEqual([`src/refusal.ts imports "./missing.js", which is not a file under src/ or scripts/`]);
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
