import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { limitFindings, named } from "../scripts/limits.js";
import { copy, edit, run } from "./allowlist-copy.js";

const LIST = "scripts/allow/limits.tsv";

/** The findings a run reports the list lacks, each as its key. */
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

const BREACHES: Record<string, string> = {
  "src/b/lines.ts": Array.from({ length: 301 }, (_, i) => `export const a${i} = ${i};\n`).join(""),
  "src/b/long.ts": long("tooLong", 51),
  "src/b/branchy.ts": `export function branchy(n: number) {\n  let t = 0;\n${Array.from({ length: 10 }, (_, i) => `  if (n === ${i}) t++;\n`).join("")}  return t;\n}\n`,
  "src/b/deep.ts":
    "export function deep(n: number) {\n  if (n) {\n    if (n > 1) {\n      if (n > 2) {\n        if (n > 3) {\n          return 4;\n        }\n      }\n    }\n  }\n  return 0;\n}\n",
  "src/b/many.ts":
    "export function many(a: number, b: number, c: number, d: number, e: number) {\n  return a + b + c + d + e;\n}\n",
  "src/b/pick.ts": 'export const pick = (n: number) => (n > 1 ? "a" : n > 0 ? "b" : "c");\n',
  "src/b/shadow.ts": "const top = 1;\nexport function inner() {\n  const top = 2;\n  return top;\n}\nexport { top };\n",
};
const KEYS = [
  "src/b/branchy.ts\tcomplexity\tFunction 'branchy'\t#1",
  "src/b/deep.ts\tmax-depth\t-\t#1",
  "src/b/lines.ts\tmax-lines\tFile\t#1",
  "src/b/long.ts\tmax-lines-per-function\tFunction 'tooLong'\t#1",
  "src/b/many.ts\tmax-params\tFunction 'many'\t#1",
  "src/b/pick.ts\tno-nested-ternary\t-\t#1",
  "src/b/shadow.ts\t@typescript-eslint/no-shadow\t'top'\t#1",
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
      `not in ${LIST}: src/clean.ts\tmax-lines-per-function\tFunction 'fiftyOne'\t#1 (line 1: Function 'fiftyOne' has too many lines (51). Maximum allowed is 50.); remove it, or add the line with the reason it stays`,
    );
  });

  it("fails on a line listed for a file that passes", async () => {
    const dir = await copy();
    await appendFile(join(dir, LIST), "src/refusal.ts\tcomplexity\tFunction 'refuse'\t#1\tonce complex\n");
    const r = run("limits", dir);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/limits\.tsv:\d+ is no longer found: src\/refusal\.ts\tcomplexity\tFunction 'refuse'\t#1;/);
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
    expect(missing(r.out)).toEqual(KEYS);
  });

  it("finds an unnamed arrow function over a limit", async () => {
    const dir = await copy();
    await plant(dir, {
      "src/anon.ts": `export default (a: number, b: number, c: number, d: number, e: number) => a + b + c + d + e;\n`,
      "src/callback.ts": `export const all = [1].map(${long("x", 51).replace("export function x", "function")});\n`,
    });
    const r = run("limits", dir);
    expect(r.status).toBe(1);
    expect(missing(r.out)).toEqual([
      "src/anon.ts\tmax-params\tArrow function\t#1",
      "src/callback.ts\tmax-lines-per-function\tFunction\t#1",
    ]);
  });

  it("checks every code file under src/: other extensions, hidden folders and node_modules", async () => {
    const dir = await copy();
    const ternary = 'export const pick = (n: number) => (n > 1 ? "a" : n > 0 ? "b" : "c");\n';
    await plant(dir, {
      "src/node_modules/x.ts": ternary,
      "src/.hidden/y.js": ternary.replace(": number", ""),
      "src/z.mts": ternary,
    });
    expect(missing(run("limits", dir).out)).toEqual([
      "src/.hidden/y.js\tno-nested-ternary\t-\t#1",
      "src/node_modules/x.ts\tno-nested-ternary\t-\t#1",
      "src/z.mts\tno-nested-ternary\t-\t#1",
    ]);
  });

  it("keys a breach without its line, so lines added above every listed breach change nothing", async () => {
    const dir = await copy();
    const files = (await readdir(join(dir, "src"), { recursive: true })).filter((f) => f.endsWith(".ts"));
    for (const file of files) {
      const at = join(dir, "src", file);
      const text = await readFile(at, "utf8");
      const start = text.startsWith("#!") ? text.indexOf("\n") + 1 : 0;
      await writeFile(at, `${text.slice(0, start)}// A note on what this module does.\n\n${text.slice(start)}`);
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

describe("a limit's key", () => {
  it("names the function or the shadowed name eslint's message gives, and - when it gives none", () => {
    expect(named("Async function 'scan' has too many lines (114). Maximum allowed is 50.")).toBe(
      "Async function 'scan'",
    );
    expect(named("Arrow function has a complexity of 12. Maximum allowed is 10.")).toBe("Arrow function");
    expect(named("Method 'run' has too many parameters (5). Maximum allowed is 4.")).toBe("Method 'run'");
    expect(named("File has too many lines (301). Maximum allowed is 300.")).toBe("File");
    expect(named("'line' is already declared in the upper scope on line 12 column 5.")).toBe("'line'");
    expect(named("Blocks are nested too deeply (4). Maximum allowed is 3.")).toBe("-");
    expect(named("Do not nest ternary expressions.")).toBe("-");
  });

  it("numbers breaches of the same file, rule and name in order, so one more is a finding of its own", () => {
    const at = (line: number) => ({
      file: "src/a.ts",
      rule: "max-depth",
      line,
      column: 3,
      message: "Blocks are nested",
    });
    const shadow = { file: "src/a.ts", rule: "no-shadow", line: 1, column: 1, message: "'x' is already declared" };
    expect([...limitFindings([at(40), shadow, at(9)])]).toEqual([
      ["src/a.ts\tno-shadow\t'x'\t#1", "line 1: 'x' is already declared"],
      ["src/a.ts\tmax-depth\t-\t#1", "line 9: Blocks are nested"],
      ["src/a.ts\tmax-depth\t-\t#2", "line 40: Blocks are nested"],
    ]);
  });
});
