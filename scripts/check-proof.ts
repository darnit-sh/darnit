// The node steps of scripts/check-proof.sh, which runs the changed tests on this change (head) and on
// base's code (base), writing each runner's output to $OUT.
//   check-proof.ts exports   on head: lists the values each src/ module exports
//   check-proof.ts mark      on base, before its run: adds what head's modules export and base's do not
//   check-proof.ts           after both runs: prints the proof table as Markdown, exits 1 with no proof
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";

type Result = { status: string; why: string; file: string };
const env = process.env;
const MISSING = "does not exist without this change";
const lines = (s = "") => s.split("\n").filter(Boolean);
const read = (f: string) => (existsSync(`${env.OUT}/${f}`) ? readFileSync(`${env.OUT}/${f}`, "utf8") : "");
const first = (s = "") => s.split("\n").find((l) => l.trim())?.trim().slice(0, 200) ?? "";
// Inline code in a table cell: one line, no backtick that ends it and no pipe that splits the cell.
const code = (s: string) => `\`${s.replace(/[\r\n]/g, " ").replace(/`/g, "'").replace(/\|/g, "¦")}\``;

/** The values (not types) each module under src/ exports, read by the project's TypeScript. */
function exported(): Record<string, string[]> {
  const ts = createRequire(join(process.cwd(), "package.json"))("typescript") as typeof import("typescript");
  const files = readdirSync("src", { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(e.parentPath, e.name));
  const options = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022, noEmit: true, skipLibCheck: true, types: [] };
  const program = ts.createProgram(files, options);
  const checker = program.getTypeChecker();
  const value = (s: import("typescript").Symbol) => ((s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s).flags & ts.SymbolFlags.Value) !== 0;
  return Object.fromEntries(
    files.map((f) => {
      const module = checker.getSymbolAtLocation(program.getSourceFile(f)!);
      return [f, module ? checker.getExportsOfModule(module).filter(value).map((s) => s.name) : []];
    }),
  );
}

if (process.argv[2] === "exports") {
  writeFileSync(`${env.OUT}/head.exports`, JSON.stringify(exported()));
  process.exit(0);
}
if (process.argv[2] === "mark") {
  // Vitest reads a name a module does not export as undefined, so a test could fail on base for that
  // alone. Each value head exports and base does not becomes, on base, a value that throws when used,
  // however a test reaches it: an import, a namespace, a helper's re-export, or a cast.
  const head = JSON.parse(read("head.exports")) as Record<string, string[]>;
  const base = exported();
  for (const [file, names] of Object.entries(head)) {
    const missing = names.filter((n) => !base[file]?.includes(n) && /^[A-Za-z_$][\w$]*$/.test(n));
    if (missing.length === 0) continue;
    const values = missing.map((n, i) => `const __proofMissing${i} = __proofMissing("${n}");\nexport { __proofMissing${i} as ${n} };`);
    const helper = `function __proofMissing(name: string): any { const fail = () => { throw new Error(name + " ${MISSING}"); }; return new Proxy(function () {}, { get: fail, apply: fail, construct: fail, has: fail, ownKeys: fail, getPrototypeOf: fail, set: fail }); }`;
    writeFileSync(file, `${existsSync(file) ? readFileSync(file, "utf8") : ""}\n${helper}\n${values.join("\n")}\n`);
  }
  process.exit(0);
}

const tests = new Set(lines(env.TESTS));
/** One result per test, fixture case or scenario; one that never ran on a side is missing there. */
function results(side: string): Map<string, Result> {
  const r = new Map<string, Result>();
  const json = read(`${side}.json`);
  for (const f of json ? (JSON.parse(json) as Vitest).testResults : []) {
    const file = relative(process.cwd(), f.name);
    if (!tests.has(file)) continue;
    if (f.assertionResults.length === 0) r.set(file, { status: f.status === "failed" ? "load" : f.status, why: first(f.message), file });
    for (const a of f.assertionResults) {
      // Two tests with one name keep apart by their order, which is the same on both sides.
      let key = `${file} > ${a.fullName}`;
      for (let i = 2; r.has(key); i++) key = `${file} > ${a.fullName} (${i})`;
      r.set(key, { status: a.status, why: first(a.failureMessages?.[0]), file });
    }
  }
  // The fixture runner and scripts/e2e.ts print "✓ <name>" or "✗ <name>", then the problems indented.
  const printed = (text: string, name: string) => {
    const all = text.split("\n");
    const at = all.findIndex((l) => l === `✓ ${name}` || l === `✗ ${name}`);
    if (at < 0) return undefined;
    return { status: all[at]!.startsWith("✓") ? "passed" : "failed", why: first(all[at + 1]?.startsWith("    ") ? all[at + 1] : "") };
  };
  for (const c of lines(env.CASES)) {
    const found = printed(read(`${side}.cases`), c.replace(/^packs\/([^/]+)\/([^/]+)\/fixtures\/(.+)$/, "$1/$2 · $3"));
    r.set(c, found ? { ...found, file: c } : { status: "load", why: "the pack is not on base", file: c });
  }
  for (const s of lines(env.SCENARIOS)) {
    const found = printed(read(`${side}.e2e`), s.slice("test/e2e/".length));
    r.set(s, found ? { ...found, file: s } : { status: "load", why: "did not run", file: s });
  }
  return r;
}
type Vitest = {
  testResults: { name: string; status: string; message: string; assertionResults: { fullName: string; status: string; failureMessages?: string[] }[] }[];
};

const head = results("head");
const base = results("base");
const broken = [...tests, ...lines(env.CASES), ...lines(env.SCENARIOS)].filter((t) => ![...head.values()].some((r) => r.file === t));
const failing = [...head].filter(([, r]) => r.status === "failed" || r.status === "load");
if (broken.length > 0 || failing.length > 0) {
  console.log("**Failed:** the changed tests must pass on this change. Failing or not run:\n");
  for (const t of broken) console.log(`- ${code(t)} did not run`);
  for (const [name, r] of failing) console.log(`- ${code(name)}: ${code(r.why || r.status)}`);
  process.exit(1);
}

const feat = env.TYPE === "feat";
const rows: string[] = [];
const notLoaded: string[] = [];
let passedOnBase = 0;
for (const [name, r] of base) {
  // A file that did not load on base has no tests there to match; every changed test passed on head.
  if (r.status !== "load" && head.get(name)?.status !== "passed") continue;
  if (r.status === "passed") passedOnBase++;
  if (r.status !== "failed" && r.status !== "load") continue;
  const label = r.file.startsWith("test/e2e/") ? "did not run" : r.file.startsWith("packs/") ? "new pack" : "new export";
  // A call to an import that is undefined names vitest's import variable: something base does not have.
  const load = r.status === "load" || r.why.includes(MISSING) || /__vite_ssr_import_\d+__/.test(r.why);
  if (load && !feat) notLoaded.push(`- ${code(name)}: ${code(r.why || "did not load")}`);
  else rows.push(`| ${code(name)} | ${load ? `${label}: ` : "fails: "}${code(r.why || r.status)} | passes |`);
}

if (rows.length === 0) {
  if (notLoaded.length > 0) {
    console.log("**Failed:** each changed test that fails without this change uses something base does not have. A fix proves itself through code base has, such as `check()` or the CLI.\n");
    console.log(notLoaded.join("\n"));
  } else console.log("**Failed:** every changed test also passes without this change, so none of them shows what it fixes or adds.");
  process.exit(1);
}
console.log(`**Passed:** ${rows.length} changed ${rows.length === 1 ? "test fails" : "tests fail"} without this change and ${rows.length === 1 ? "passes" : "pass"} with it.\n`);
console.log("| Test | Without this change | With it |\n| --- | --- | --- |");
console.log(rows.join("\n"));
if (notLoaded.length > 0) console.log(`\nNot counted, since they use something base does not have:\n\n${notLoaded.join("\n")}`);
if (passedOnBase > 0) console.log(`\n${passedOnBase} other ${passedOnBase === 1 ? "test" : "tests"} in the changed files ${passedOnBase === 1 ? "passes" : "pass"} with and without this change.`);
