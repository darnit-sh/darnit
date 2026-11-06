import { describe, expect, it } from "vitest";
import { importsOf } from "./import-graph.js";

/** What the graph finds it cannot follow in one file: computed paths, then other uses of require or createRequire. */
function unfollowed(text: string): string[] {
  const found = importsOf("src/x.ts", text);
  return [...found.computed, ...found.loaders];
}

describe("a require or createRequire the graph cannot follow fails", () => {
  const forms: [string, string, string[]][] = [
    [
      "createRequire imported under another name",
      `import { createRequire as makeRequire } from "node:module";\nconst load = makeRequire(import.meta.url);\nload("../check.js");`,
      ["createRequireasmakeRequire"],
    ],
    [
      "createRequire imported by a string name",
      `import { "createRequire" as makeRequire } from "node:module";`,
      [`"createRequire"asmakeRequire`],
    ],
    ["require held in a variable", `const req = require;\nreq("../check.js");`, ["req=require"]],
    [
      "createRequire through a namespace",
      `import * as nodeModule from "node:module";\nnodeModule.createRequire(import.meta.url)("./check.js");`,
      [`nodeModule.createRequire(import.meta.url)("./check.js")`],
    ],
    [
      "createRequire on another module object",
      `mod.createRequire(import.meta.url)("./check.js");`,
      [`mod.createRequire(import.meta.url)("./check.js")`],
    ],
    ["require in parentheses", `(require)("./check.js");`, [`(require)("./check.js")`]],
    ["module.require", `module.require("./check.js");`, [`module.require("./check.js")`]],
    ["globalThis.require", `globalThis.require("./check.js");`, [`globalThis.require("./check.js")`]],
    ["require by key", `globalThis["require"]("./check.js");`, [`globalThis["require"]("./check.js")`]],
    [
      "createRequire assigned later",
      `let r;\nr = createRequire(import.meta.url);\nr("./check.js");`,
      ["createRequire(import.meta.url)"],
    ],
    [
      "createRequire held in a variable",
      `const load = createRequire(import.meta.url);\nload("./check.js");`,
      ["createRequire(import.meta.url)"],
    ],
    [
      "createRequire destructured",
      `const { createRequire: make } = await import("node:module");`,
      ["createRequire:make"],
    ],
    ["require.resolve", `const at = require.resolve("./check.js");`, [`require.resolve("./check.js")`]],
    ["require named by a declaration", `const require = make(import.meta.url);`, ["require=make(import.meta.url)"]],
    ["require passed along", `run(require);`, ["run(require)"]],
    ["require with a second argument", `require("./check.js", extra);`, [`require("./check.js",extra)`]],
    ["module.require read, not called", `const r = module.require;\nr("./check.js");`, ["module.require"]],
    ["createRequire read, not called", `const make = nodeModule.createRequire;`, ["nodeModule.createRequire"]],
    ["require called on another object", `loader.require("./check.js");`, [`loader.require("./check.js")`]],
    ["require destructured by a string key", `const { "require": r } = globalThis;`, [`"require":r`]],
  ];
  for (const [form, text, found] of forms)
    it(form, () => {
      expect(unfollowed(text)).toEqual(found);
      expect(importsOf("src/x.ts", text).paths).not.toContain("./check.js");
    });
});

describe("a require or createRequire the graph follows", () => {
  it("require() and createRequire(url)() with a literal path", () => {
    const text = `import { createRequire } from "node:module";\nrequire("./a.js");\ncreateRequire(import.meta.url)("./b.js");\ncreateRequire(here)(\`./c.js\`);`;
    expect(importsOf("src/x.ts", text).paths).toEqual(["node:module", "./a.js", "./b.js", "./c.js"]);
    expect(unfollowed(text)).toEqual([]);
  });

  it("with a computed path, as a computed call", () => {
    expect(unfollowed("require(name);\ncreateRequire(import.meta.url)(dir + name);")).toEqual([
      "require(name)",
      "createRequire(import.meta.url)(dir+name)",
    ]);
  });

  it("only as code: comments, strings and regex literals that mention it are not uses", () => {
    expect(unfollowed(`// require("./a.js")\nconst s = "createRequire(x)";\nconst r = /require\\(/;`)).toEqual([]);
  });
});

describe("code that only shares the name of require or createRequire", () => {
  const lines = [
    `const opts = { require: true };`,
    `const s = "require";`,
    `interface Rule { require?: string[] }`,
    `if (cfg.require) run();`,
    `type K = "createRequire";`,
    `let loader: typeof require;`,
    `class Rules { require = false; createRequire(): void {} }`,
    `enum Kind { require }`,
    `const { mode = "require" } = opts;`,
  ];
  for (const line of lines)
    it(line, () => {
      expect(unfollowed(line)).toEqual([]);
    });
});
