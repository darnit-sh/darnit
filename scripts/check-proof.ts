// The two node steps of scripts/check-proof.sh, which runs the changed tests on this change (head) and
// on base's code (base), writing each runner's output to $OUT.
//   check-proof.ts mark    before the base run: marks the test files' imports that base does not have
//   check-proof.ts         after it: prints the proof table as Markdown, exits 1 when there is no proof
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";

type Result = { status: string; why: string; file: string };
const env = process.env;
const MISSING = "does not exist without this change";
const lines = (s = "") => s.split("\n").filter(Boolean);
const read = (f: string) => (existsSync(`${env.OUT}/${f}`) ? readFileSync(`${env.OUT}/${f}`, "utf8") : "");
const first = (s = "") => s.split("\n").find((l) => l.trim())?.trim().slice(0, 200) ?? "";
// Inline code in a table cell: no backtick can end it and no pipe can split the cell.
const code = (s: string) => `\`${s.replace(/`/g, "'").replace(/\|/g, "¦")}\``;

if (process.argv[2] === "mark") {
  // Vitest reads a name a module does not export as undefined, so a test could fail on base for that
  // alone. Each such import the type checker names on base's code becomes a value that throws when
  // used; any other import error stops the whole file from loading.
  const errors = [...read("base.tsc").matchAll(/^(test\/[^(]+)\((\d+),(\d+)\): error TS(\d+): (.*)$/gm)];
  // Values go on the first line, so the file keeps its line numbers and code outside the tests can use them.
  const files = new Map<string, { src: string[]; values: string }>();
  let n = 0;
  for (const [, file, line, col, num, text] of errors.sort((a, b) => Number(b[3]) - Number(a[3]))) {
    const member = ["2305", "2459", "2614", "2724"].includes(num!);
    if (!member && !["1192", "2307"].includes(num!) && !/^Property .* on type 'typeof import\(/.test(text!)) continue;
    const f = files.get(file!) ?? { src: readFileSync(file!, "utf8").split("\n"), values: "" };
    files.set(file!, f);
    const at = Number(line) - 1;
    const start = Number(col) - 1;
    const name = /^(\w+)(\s+as\s+(\w+))?/.exec(f.src[at]!.slice(start));
    if (member && name) {
      f.src[at] = `${f.src[at]!.slice(0, start)}${name[1]} as __missing${n++}${f.src[at]!.slice(start + name[0].length)}`;
      f.values += `const ${name[3] ?? name[1]} = __missing("${name[1]}"); `;
    } else f.src.push(`throw new Error("this file ${MISSING}");`);
  }
  const helper = `function __missing(name) { const fail = () => { throw new Error(name + " ${MISSING}"); }; return new Proxy(function () {}, { get: fail, apply: fail, construct: fail, has: fail, ownKeys: fail, getPrototypeOf: fail, set: fail }); }`;
  for (const [file, { src, values }] of files) writeFileSync(file, [values + src[0], ...src.slice(1), helper, ""].join("\n"));
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
    for (const a of f.assertionResults) r.set(`${file} > ${a.fullName}`, { status: a.status, why: first(a.failureMessages?.[0]), file });
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
  const load = r.status === "load" || r.why.includes(MISSING);
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
if (passedOnBase > 0) console.log(`\n${passedOnBase} other changed ${passedOnBase === 1 ? "test passes" : "tests pass"} with and without this change.`);
