import { appendFile, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { limitFindings, measured } from "../scripts/limits.js";
import { copy, edit, npm, run } from "./allowlist-copy.js";

const LIST = "scripts/allow/limits.tsv";

/** The findings a run reports the list lacks, each as its key and measure. */
const missing = (out: string) =>
  out
    .split("\n")
    .filter((l) => l.startsWith(`not in ${LIST}: `))
    .map((l) => l.slice(`not in ${LIST}: `.length).replace(/ \(line \d+: .*$/, ""))
    .sort();

/** A function of `lines` lines in all. */
const long = (name: string, lines: number) =>
  [
    `export function ${name}(input: number): number {`,
    "  let total = input;",
    ...Array.from({ length: lines - 4 }, (_, i) => `  total += ${i};`),
    "  return total;",
    "}",
    "",
  ].join("\n");
const ifs = (n: number) => Array.from({ length: n }, (_, i) => `  if (n === ${i}) t++;\n`).join("");
const TERNARY = 'export const pick = (n: number) => (n > 1 ? "a" : n > 0 ? "b" : "c");\n';

const BREACHES: Record<string, string> = {
  "src/b/lines.ts": Array.from({ length: 301 }, (_, i) => `export const a${i} = ${i};\n`).join(""),
  "src/b/long.ts": long("tooLong", 51),
  "src/b/branchy.ts": `export function branchy(n: number) {\n  let t = 0;\n${ifs(10)}  return t;\n}\n`,
  "src/b/deep.ts":
    "export function deep(n: number) {\n  if (n) {\n    if (n > 1) {\n      if (n > 2) {\n        if (n > 3) {\n          return 4;\n        }\n      }\n    }\n  }\n  return 0;\n}\n",
  "src/b/many.ts":
    "export function many(a: number, b: number, c: number, d: number, e: number) {\n  return a + b + c + d + e;\n}\n",
  "src/b/pick.ts": TERNARY,
  "src/b/shadow.ts": "const top = 1;\nexport function inner() {\n  const top = 2;\n  return top;\n}\nexport { top };\n",
};
const KEYS = [
  "src/b/branchy.ts\tcomplexity\tbranchy\t11",
  "src/b/deep.ts\tmax-depth\tdeep\t4",
  "src/b/lines.ts\tmax-lines\t(file)\t301",
  "src/b/long.ts\tmax-lines-per-function\ttooLong\t51",
  "src/b/many.ts\tmax-params\tmany\t5",
  "src/b/pick.ts\tno-nested-ternary\tpick\t1",
  "src/b/shadow.ts\t@typescript-eslint/no-shadow\tinner\t1",
];

async function plant(dir: string, files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(join(dir, file, ".."), { recursive: true });
    await writeFile(join(dir, file), text);
  }
}

describe("npm run limits", () => {
  it("fails on a 51 line function in a clean file, and passes one of 50", async () => {
    const dir = await copy();
    await plant(dir, { "src/clean.ts": long("fifty", 50) });
    expect(run("limits", dir)).toMatchObject({ status: 0 });
    await plant(dir, { "src/clean.ts": long("fiftyOne", 51) });
    const r = run("limits", dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain(
      `not in ${LIST}: src/clean.ts\tmax-lines-per-function\tfiftyOne\t51 (line 1: Function 'fiftyOne' has too many lines (51). Maximum allowed is 50.); remove it, or add the line with the reason it stays`,
    );
  });

  it("fails on a line listed for a file that passes", async () => {
    const dir = await copy();
    await appendFile(join(dir, LIST), "src/refusal.ts\tcomplexity\trefuse\t12\tonce complex\n");
    const r = run("limits", dir);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/limits\.tsv:\d+ is no longer found: src\/refusal\.ts\tcomplexity\trefuse\t12;/);
    expect(missing(r.out)).toEqual([]);
  });

  it("finds a breach of each of the seven limits, and nothing else", async () => {
    const dir = await copy();
    await plant(dir, BREACHES);
    const r = run("limits", dir);
    expect(r.status).toBe(1);
    expect(missing(r.out)).toEqual(KEYS);
    expect(r.out).not.toContain("no longer found");
  });

  it("is not passed by a comment that turns a rule off, or by an eslint config of the folder's own", async () => {
    const dir = await copy();
    const off = "/* eslint-disable */\n// eslint-disable-next-line max-params, max-depth, no-nested-ternary\n";
    await plant(dir, Object.fromEntries(Object.entries(BREACHES).map(([file, text]) => [file, off + text])));
    await edit(
      join(dir, "src/b/branchy.ts"),
      "export function",
      '/* eslint complexity: ["error", 50] */\nexport function',
    );
    await writeFile(join(dir, "eslint.config.js"), 'export default [{ ignores: ["src/**"] }];\n');
    const pkg = join(dir, "package.json");
    await writeFile(pkg, JSON.stringify({ ...JSON.parse(await readFile(pkg, "utf8")), eslintConfig: { root: true } }));
    const r = run("limits", dir);
    expect(r.status).toBe(1);
    // The two comment lines count toward the file's length.
    expect(missing(r.out)).toEqual(KEYS.map((k) => k.replace("(file)\t301", "(file)\t303")));
  });

  it("checks every code file under src/: each extension, hidden folders, node_modules, a folder named like a file and a linked file", async () => {
    const dir = await copy();
    const jsx = 'export const P = (n) => <b>{n > 1 ? "a" : n > 0 ? "b" : "c"}</b>;\n';
    await plant(dir, {
      "src/node_modules/x.ts": TERNARY,
      "src/.hidden/y.js": TERNARY.replace(": number", ""),
      "src/z.mts": TERNARY,
      "src/c.cts": TERNARY,
      "src/v.tsx": jsx.replace("(n)", "(n: number)"),
      "src/w.jsx": jsx,
      "src/dir.ts/inner.ts": TERNARY,
      "outside.ts": TERNARY,
    });
    await symlink("../outside.ts", join(dir, "src/link.ts"));
    expect(missing(run("limits", dir).out)).toEqual([
      "src/.hidden/y.js\tno-nested-ternary\tpick\t1",
      "src/c.cts\tno-nested-ternary\tpick\t1",
      "src/dir.ts/inner.ts\tno-nested-ternary\tpick\t1",
      "src/link.ts\tno-nested-ternary\tpick\t1",
      "src/node_modules/x.ts\tno-nested-ternary\tpick\t1",
      "src/v.tsx\tno-nested-ternary\tP\t1",
      "src/w.jsx\tno-nested-ternary\tP\t1",
      "src/z.mts\tno-nested-ternary\tpick\t1",
    ]);
  });

  it("fails on a link to a folder under src/, so each breach is listed under the path it is edited at", async () => {
    const dir = await copy();
    await plant(dir, { "lib/x.ts": TERNARY });
    await symlink("../lib", join(dir, "src/lib"));
    const r = run("limits", dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/lib is a link to a folder; keep the code in src/ itself");
  });

  it("keys a breach without its line, so moving every listed breach down changes nothing", async () => {
    const dir = await copy();
    const files = (await readdir(join(dir, "src"), { recursive: true })).filter((f) => f.endsWith(".ts"));
    for (const file of files) {
      const at = join(dir, "src", file);
      const text = await readFile(at, "utf8");
      const start = text.startsWith("#!") ? text.indexOf("\n") + 1 : 0;
      // Two blank lines go where two lines are added, so each file keeps its length.
      const rest = text.slice(start).replace("\n\n", "\n").replace("\n\n", "\n");
      await writeFile(at, `${text.slice(0, start)}// A note on what this module does.\n\n${rest}`);
    }
    expect(run("limits", dir)).toMatchObject({ status: 0 });
  });

  it("fails on a file eslint cannot parse rather than passing it", async () => {
    const dir = await copy();
    await plant(dir, { "src/broken.ts": "export const = ;\n" });
    const r = run("limits", dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain("eslint could not check src/broken.ts:1: Parsing error");
  });
});

describe("a listed breach", () => {
  it("fails once it grows past the cap its line gives", async () => {
    const dir = await copy();
    const lines = Array.from({ length: 300 }, (_, i) => `  if (files.length === ${i}) void i;\n`).join("");
    await edit(
      join(dir, "src/check.ts"),
      "}> {\n  const hits: Hit[] = [];\n",
      `}> {\n  const i = 0;\n${lines}  const hits: Hit[] = [];\n`,
    );
    const r = run("limits", dir);
    expect(r.status).toBe(1);
    const over = r.out.split("\n").filter((l) => l.includes("above the cap"));
    expect(over.map((l) => /^not in [^:]+: (src\/check\.ts\t[^\t]+\t[^\t]+)\t\d+/.exec(l)?.[1]).sort()).toEqual([
      "src/check.ts\tcomplexity\tscan",
      "src/check.ts\tmax-lines\t(file)",
      "src/check.ts\tmax-lines-per-function\tscan",
    ]);
    expect(r.out).not.toContain("no longer found");
  });

  it("passes at or below its cap, and fails one above", async () => {
    const dir = await copy();
    const list = join(dir, LIST);
    const text = await readFile(list, "utf8");
    const [, cap] = /^src\/check\.ts\tcomplexity\tscan\t(\d+)\t/m.exec(text)!;
    const capped = (n: number) =>
      text.replace(`src/check.ts\tcomplexity\tscan\t${cap}\t`, `src/check.ts\tcomplexity\tscan\t${n}\t`);
    await writeFile(list, capped(Number(cap) + 5));
    expect(run("limits", dir)).toMatchObject({ status: 0 });
    await writeFile(list, capped(Number(cap) - 1));
    const r = run("limits", dir);
    expect(r.status).toBe(1);
    expect(missing(r.out)).toEqual([`src/check.ts\tcomplexity\tscan\t${cap}`]);
    expect(r.out).toContain(`above the cap of ${Number(cap) - 1} its line gives`);
  });

  it("cannot be traded for a new breach of the same rule in another function of the file", async () => {
    const dir = await copy();
    const fix = join(dir, "src/fix.ts");
    await edit(fix, ": mixed.has(key(hit))\n          ? MIXED\n          : LOCAL;", ": LOCAL;");
    await appendFile(fix, 'export const grade = (n: number) => (n > 90 ? "a" : n > 80 ? "b" : "c");\n');
    const r = run("limits", dir);
    expect(r.status).toBe(1);
    expect(missing(r.out)).toContain("src/fix.ts\tno-nested-ternary\tgrade\t1");
  });

  it("is measured inside an immediately invoked function and a class static block", async () => {
    const dir = await copy();
    const body = long("x", 124).split("\n").slice(1, -2).join("\n");
    await plant(dir, {
      "src/iife.ts": `export const table = (() => {\n${body}\n})();\n`,
      "src/statics.ts": `export class K {\n  static n = 0;\n  static {\n    let t = 0;\n    const n = K.n;\n${ifs(10)}    K.n = t;\n  }\n}\n`,
    });
    const r = run("limits", dir);
    expect(r.status).toBe(1);
    expect(missing(r.out)).toEqual([
      "src/iife.ts\tmax-lines-per-function\ttable\t124",
      "src/statics.ts\tcomplexity\tK\t11",
    ]);
  });
});

describe("a breach in a method with a computed key", () => {
  it("is found and named by what holds it, without the check hanging", async () => {
    const dir = await copy();
    await plant(dir, {
      "src/iter.ts":
        "export const bag = { *[Symbol.iterator](a: number, b: number, c: number, d: number, e: number) { yield a + b + c + d + e; } };\n",
      "src/tpl.ts": `export const o = { [\`k\${1}\`](n: number) { return n > 1 ? "a" : n > 0 ? "b" : "c"; } };\n`,
    });
    const r = run("limits", dir);
    expect(r.out).not.toContain("killed by");
    expect(r.status).toBe(1);
    expect(missing(r.out)).toEqual(["src/iter.ts\tmax-params\t(top)\t5", "src/tpl.ts\tno-nested-ternary\t(top)\t1"]);
  });

  it("is measured by the rule's own number, not one in the key", async () => {
    const dir = await copy();
    await plant(dir, {
      "src/paren.ts": `export const api = {\n  async ["(1)"](n: number) {\n    let t = 0;\n${ifs(41)}    return t;\n  },\n};\n`,
    });
    await appendFile(join(dir, LIST), "src/paren.ts\tcomplexity\t(top)\t13\tlisted at 13\n");
    const r = run("limits", dir);
    expect(r.status).toBe(1);
    expect(missing(r.out)).toEqual(["src/paren.ts\tcomplexity\t(top)\t42"]);
    expect(r.out).toContain("above the cap of 13 its line gives");
  });
});

describe("nesting depth", () => {
  // try blocks count toward depth and not toward complexity, so only the depth breaks a limit.
  const deep = (depth: number) => `${"  try {\n".repeat(depth)}    n++;\n${"  } finally {\n  }\n".repeat(depth)}`;

  it("is one line per function, capped at its deepest block", async () => {
    const dir = await copy();
    await plant(dir, {
      "src/d.ts": `export function f(n: number) {\n${deep(4)}${deep(5)}${deep(4)}  return n;\n}\n`,
      "src/twice.ts": `export class A {\n  run(n: number) {\n${deep(4)}    return n;\n  }\n}\nexport class B {\n  run(n: number) {\n${deep(5)}    return n;\n  }\n}\n`,
    });
    expect(missing(run("limits", dir).out)).toEqual([
      "src/d.ts\tmax-depth\tf\t5",
      "src/twice.ts\tmax-depth\trun\t4",
      "src/twice.ts\tmax-depth\trun #2\t5",
    ]);
  });

  it("passes any block at or below the function's cap, and fails one deeper", async () => {
    const dir = await copy();
    await appendFile(join(dir, LIST), "src/d.ts\tmax-depth\tf\t5\tlisted at 5\n");
    await plant(dir, { "src/d.ts": `export function f(n: number) {\n${deep(5)}${deep(5)}  return n;\n}\n` });
    expect(run("limits", dir)).toMatchObject({ status: 0 });
    await plant(dir, { "src/d.ts": `export function f(n: number) {\n${deep(5)}${deep(6)}  return n;\n}\n` });
    const r = run("limits", dir);
    expect(r.status).toBe(1);
    expect(missing(r.out)).toEqual(["src/d.ts\tmax-depth\tf\t6"]);
  });
});

describe("the eslint the check runs", () => {
  it("is the one the repository installs, not a folder of the same name committed under scripts/", async () => {
    const dir = await copy();
    await plant(dir, {
      "scripts/node_modules/eslint/package.json": '{ "name": "eslint", "main": "index.js" }\n',
      // Every file but one goes to the real eslint, so only the breach in that file goes unseen.
      "scripts/node_modules/eslint/index.js": [
        'const real = require("../../../node_modules/eslint");',
        "class Linter extends real.Linter {",
        "  verify(text, config, options) {",
        '    return options.filename.endsWith("clean.ts") ? [] : super.verify(text, config, options);',
        "  }",
        "}",
        "module.exports = { ...real, Linter };",
        "",
      ].join("\n"),
      "src/clean.ts": long("fiftyOne", 51),
    });
    const r = npm(dir, "limits");
    expect(r.status).toBe(1);
    expect(missing(r.out)).toEqual(["src/clean.ts\tmax-lines-per-function\tfiftyOne\t51"]);
  });
});

describe("a limit's key", () => {
  it("names the nearest named function: a declaration, a const, a property key, a method, an IIFE, the default export, or (top)", async () => {
    const dir = await copy();
    await plant(dir, {
      "src/names.ts": [
        'export const top = (n: number) => (n > 1 ? "a" : n > 0 ? "b" : "c");',
        "export const props = {",
        '  key: (n: number) => (n > 1 ? "a" : n > 0 ? "b" : "c"),',
        '  "quoted key": function (n: number) {',
        '    return n > 1 ? "a" : n > 0 ? "b" : "c";',
        "  },",
        "};",
        "export class C {",
        "  run(n: number) {",
        '    return [n].map((m) => (m > 1 ? "a" : m > 0 ? "b" : "c"));',
        "  }",
        '  field = (n: number) => (n > 1 ? "a" : n > 0 ? "b" : "c");',
        "}",
        'export const table = ((n: number) => (n > 1 ? "a" : n > 0 ? "b" : "c"))(1);',
        'export const bare = 1 > 0 ? "a" : 0 > 1 ? "b" : "c";',
        "exports.assigned = function (n: number) {",
        '  return n > 1 ? "a" : n > 0 ? "b" : "c";',
        "};",
        "let late: (n: number) => string;",
        'late = (n) => (n > 1 ? "a" : n > 0 ? "b" : "c");',
        'export const cast = ((n: number) => (n > 1 ? "a" : n > 0 ? "b" : "c")) as (n: number) => string;',
        'export const sat = ((n: number) => (n > 1 ? "a" : n > 0 ? "b" : "c")) satisfies (n: number) => string;',
        'export const bang = ((n: number) => (n > 1 ? "a" : n > 0 ? "b" : "c"))!;',
        'export const old = <(n: number) => string>((n: number) => (n > 1 ? "a" : n > 0 ? "b" : "c"));',
        "export class P {",
        "  many(a: number, b: number, c: number, d: number, e: number) {",
        "    return a + b + c + d + e;",
        "  }",
        "  #go(a: number, b: number, c: number, d: number, e: number) {",
        "    return a + b + c + d + e + late(1).length;",
        "  }",
        "}",
        "export default (a: number, b: number, c: number, d: number, e: number) => a + b + c + d + e;",
        "",
      ].join("\n"),
    });
    expect(missing(run("limits", dir).out)).toEqual([
      "src/names.ts\tmax-params\t#go\t5",
      "src/names.ts\tmax-params\tdefault\t5",
      "src/names.ts\tmax-params\tmany\t5",
      "src/names.ts\tno-nested-ternary\t(top)\t1",
      "src/names.ts\tno-nested-ternary\tassigned\t1",
      "src/names.ts\tno-nested-ternary\tbang\t1",
      "src/names.ts\tno-nested-ternary\tcast\t1",
      "src/names.ts\tno-nested-ternary\tfield\t1",
      "src/names.ts\tno-nested-ternary\tkey\t1",
      "src/names.ts\tno-nested-ternary\tlate\t1",
      "src/names.ts\tno-nested-ternary\told\t1",
      "src/names.ts\tno-nested-ternary\tquoted key\t1",
      "src/names.ts\tno-nested-ternary\trun\t1",
      "src/names.ts\tno-nested-ternary\tsat\t1",
      "src/names.ts\tno-nested-ternary\ttable\t1",
      "src/names.ts\tno-nested-ternary\ttop\t1",
    ]);
  });

  it("numbers breaches of the same file, rule and name in order, so one more is a finding of its own", () => {
    const at = (line: number) => ({ file: "src/a.ts", rule: "no-nested-ternary", name: "run", line, column: 3 });
    const ternary = "Do not nest ternary expressions.";
    expect([
      ...limitFindings(
        [
          { ...at(40), message: ternary },
          { ...at(9), message: ternary },
        ],
        [],
      ),
    ]).toEqual([
      ["src/a.ts\tno-nested-ternary\trun\t1", `line 9: ${ternary}`],
      ["src/a.ts\tno-nested-ternary\trun #2\t1", `line 40: ${ternary}`],
    ]);
  });

  it("reads the measure from each rule's own wording, and counts a breach eslint does not measure as 1", () => {
    expect(measured("max-lines", "File has too many lines (454). Maximum allowed is 300.")).toBe(454);
    expect(measured("max-lines-per-function", "Method '(9)' has too many lines (114). Maximum allowed is 50.")).toBe(
      114,
    );
    expect(measured("complexity", "Method 'complexity of 99' has a complexity of 12. Maximum allowed is 10.")).toBe(12);
    expect(measured("max-depth", "Blocks are nested too deeply (4). Maximum allowed is 3.")).toBe(4);
    expect(measured("max-params", "Method '(7)' has too many parameters (5). Maximum allowed is 4.")).toBe(5);
    expect(
      measured("@typescript-eslint/no-shadow", "'line' is already declared in the upper scope on line 12 column 5."),
    ).toBe(1);
    expect(measured("no-nested-ternary", "Do not nest ternary expressions.")).toBe(1);
    expect(() => measured("complexity", "Method 'x' is complex (12).")).toThrow("could not read the complexity");
  });
});
