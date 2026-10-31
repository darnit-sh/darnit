import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, SgNode } from "@ast-grep/napi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { check, checkJson, checkReport, exitCodeForCheck, mentionsToJson, render, scan, snippet, toJson, type Coverage, type Hit } from "../src/check.js";
import { escapedPieces, escapeHidden, MAX_FILE_BYTES } from "../src/detect.js";
import { loadRecords } from "../src/records/load.js";
import { compilePatterns, findMatches, grammarFor } from "../src/scan/astgrep.js";
import { SDK_CLASSES } from "../src/scan/clients.js";
import { findModelValues, inside, isTestPath } from "../src/scan/values.js";
import { findMentions } from "../src/scan/mentions.js";
import { cpuTime } from "./helpers.js";

vi.mock("@ast-grep/napi", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ast-grep/napi")>();
  return { ...real, parse: vi.fn(real.parse) };
});

const SAMPLES = fileURLToPath(new URL("./samples/", import.meta.url));
const MAX_TOKENS_FIXTURE = fileURLToPath(
  new URL("../packs/openai/2024-09-12-max-tokens-to-max-completion-tokens/fixtures/basic/before/", import.meta.url),
);

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function scratch(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "darnit-check-"));
  tempDirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  return dir;
}

const locations = (hits: Hit[]) => hits.map((h) => `${h.file}:${h.line}`);

/** How much longer `findModelValues` takes on `source(1)` than on `source(1 / 8)`: 8 when linear, 64 when quadratic. Healthy runs stay under 11. */
async function growth(file: string, source: (scale: number) => string): Promise<number> {
  const grammar = grammarFor(file)!.grammar;
  const time = (scale: number, runs: number) => {
    const text = source(scale);
    return cpuTime(() => findModelValues(file, text, grammar, new Set(["gpt-4"])), runs);
  };
  // One slow full-size run pushed the ratio past 24, so both sizes take their fastest run. Each full-size run holds its trees until collected, so only two.
  const small = await time(1 / 8, 5);
  return (await time(1, 2)) / small;
}

describe("check tells OpenAI apart from look-alike clients", () => {
  const maxTokens = (hits: Hit[]) => locations(hits.filter((h) => h.record.id.includes("max-tokens")));

  it("leaves out other SDKs that copy OpenAI's methods, however the client is created", async () => {
    const dir = await scratch({
      "groq.ts": 'import Groq from "groq-sdk";\nconst groq = new Groq();\nexport const r = groq.chat.completions.create({ model: "x", messages: [], max_tokens: 5 });\n',
      "inline.js": 'import { Together } from "together-ai";\nexport const r = new Together().chat.completions.create({ model: "x", max_tokens: 5 });\n',
      "required.js": 'const Groq = require("groq-sdk");\nconst g = new Groq();\nexports.r = g.chat.completions.create({ model: "x", max_tokens: 5 });\n',
      "field.ts":
        'import Groq from "groq-sdk";\nclass Bot {\n  client = new Groq();\n  run() {\n    return this.client.chat.completions.create({ model: "x", max_tokens: 5 });\n  }\n}\nexport { Bot };\n',
      "groq.py": "from groq import Groq\n\nclient = Groq()\nr = client.chat.completions.create(model='x', max_tokens=5)\n",
    });
    const { hits, coverage } = await checkReport(dir);
    expect(maxTokens(hits)).toEqual([]);
    expect(coverage.foreign).toBe(5);
    expect(render(hits, coverage)).toContain(
      "Left out 5 calls made through another provider's client with the same methods: field.ts:5, groq.py:4, groq.ts:3, inline.js:2, required.js:3.",
    );
  });

  it("leaves out OpenAI's own SDK when a written-out address points at another provider", async () => {
    const dir = await scratch({
      "router.ts":
        'import OpenAI from "openai";\nconst client = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: "k" });\nexport const r = client.chat.completions.create({ model: "x", messages: [], max_tokens: 5 });\n',
      "deepseek.py":
        'from openai import OpenAI\n\nclient = OpenAI(api_key="k", base_url="https://api.deepseek.com")\nr = client.chat.completions.create(model="x", messages=[], max_tokens=5)\n',
      "fetch.js":
        'export const r = fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "x", max_tokens: 5 }) });\n',
    });
    expect(maxTokens(await check(dir))).toEqual([]);
  });

  it("still reports OpenAI, Azure OpenAI, and clients it cannot trace", async () => {
    const dir = await scratch({
      "plain.ts": 'import OpenAI from "openai";\nconst openai = new OpenAI();\nexport const r = openai.chat.completions.create({ model: "x", messages: [], max_tokens: 5 });\n',
      "azure.ts":
        'import { AzureOpenAI } from "openai";\nconst az = new AzureOpenAI({ baseURL: "https://acme.openai.azure.com/openai" });\nexport const r = az.chat.completions.create({ model: "x", messages: [], max_tokens: 5 });\n',
      "env.ts":
        'import OpenAI from "openai";\nconst c = new OpenAI({ baseURL: process.env.LLM_URL });\nexport const r = c.chat.completions.create({ model: "x", messages: [], max_tokens: 5 });\n',
      "param.js": "export const ask = (client) => client.chat.completions.create({ model: 'x', max_tokens: 5 });\n",
      "self.py":
        "import openai\n\nclass Bot:\n    def __init__(self):\n        self.client = openai.OpenAI()\n\n    def run(self):\n        return self.client.chat.completions.create(model='x', max_tokens=5)\n",
      "fetch.js":
        'export const r = fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "x", max_tokens: 5 }) });\n',
    });
    expect(maxTokens(await check(dir))).toEqual(["azure.ts:3", "env.ts:3", "fetch.js:1", "param.js:1", "plain.ts:3", "self.py:8"]);
  });

  it("notes calls sent to a local address written in the code, and only those", async () => {
    const call = 'export const r = c.chat.completions.create({ model: "x", messages: [], max_tokens: 5 });';
    const client = (baseURL: string) => `import OpenAI from "openai";\nconst c = new OpenAI({ baseURL: ${baseURL} });\n${call}\n`;
    const dir = await scratch({
      "ollama.ts": client('"http://localhost:11434/v1"'),
      "loopback.js": client('"http://127.0.0.1:8000/v1"'),
      "ipv6.js": client('"http://[::1]:8080/v1"'),
      "lan.py": 'from openai import OpenAI\n\nc = OpenAI(base_url="http://192.168.1.5:8080/v1")\nr = c.chat.completions.create(model="x", max_tokens=5)\n',
      "fetch.js": 'export const r = fetch("http://localhost:1234/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "x", max_tokens: 5 }) });\n',
      "openai.ts": client('"https://api.openai.com/v1"'),
      "plain.ts": client("undefined"),
      "env.ts": client("process.env.LLM_URL"),
      "evil.ts": client('"https://localhost.evil.com/v1"'),
      "nip.ts": client('"http://127.0.0.1.nip.io/v1"'),
      "userinfo.ts": client('"http://10.0.0.1@api.openai.com/v1"'),
      "public1.ts": client('"http://192.169.0.1/v1"'),
      "public2.ts": client('"http://172.32.0.1/v1"'),
      "compose.ts": client('"http://ollama:11434/v1"'),
      "user.ts": client('"http://me@localhost:8080/v1"'),
      "dot.ts": client('"http://localhost./v1"'),
      "ula.ts": client('"http://[fd00::1]:8000/v1"'),
      "mapped.ts": client('"http://[::ffff:127.0.0.1]:8000/v1"'),
      "linklocal.ts": client('"http://169.254.1.1/v1"'),
      "template.ts": client("`http://${host}/v1`"),
      "either.ts": `import OpenAI from "openai";\nlet c = new OpenAI({ baseURL: "http://localhost:1/v1" });\nif (process.env.X) c = new OpenAI({ baseURL: "http://127.0.0.1:2/v1" });\n${call}\n`,
    });
    const { hits, coverage } = await checkReport(dir);
    const local = Object.fromEntries(hits.map((h) => [`${h.file}:${h.line}`, h.local?.join(" or ") ?? null]));
    expect(local).toEqual({
      "ollama.ts:3": "localhost:11434",
      "loopback.js:3": "127.0.0.1:8000",
      "ipv6.js:3": "[::1]:8080",
      "lan.py:4": "192.168.1.5:8080",
      "fetch.js:1": "localhost:1234",
      "openai.ts:3": null,
      "plain.ts:3": null,
      "env.ts:3": null,
      "evil.ts:3": null,
      "nip.ts:3": null,
      "userinfo.ts:3": null,
      "public1.ts:3": null,
      "public2.ts:3": null,
      "compose.ts:3": "ollama:11434",
      "user.ts:3": "localhost:8080",
      "dot.ts:3": "localhost.",
      "ula.ts:3": "[fd00::1]:8000",
      "mapped.ts:3": "[::ffff:127.0.0.1]:8000",
      "linklocal.ts:3": "169.254.1.1",
      "template.ts:3": null,
      "either.ts:4": "127.0.0.1:2 or localhost:1",
    });
    expect(exitCodeForCheck(hits)).toBe(1);
    expect(render(hits, coverage)).toMatch(/ollama\.ts:3:72 +max_tokens: 5 {2}\(sent to localhost:11434; ignore if that server isn't OpenAI\)\n/);
    expect(toJson(hits).find((h) => (h as { file: string }).file === "ollama.ts")).toMatchObject({ localAddresses: ["localhost:11434"] });
    expect(toJson(hits).find((h) => (h as { file: string }).file === "plain.ts")).not.toHaveProperty("localAddresses");
  });

  it("never drops a real OpenAI call behind a wrapper, a local factory or a proxy", async () => {
    const call = 'client.chat.completions.create({ model: "m", messages: [], max_tokens: 5 });';
    const dir = await scratch({
      "factory.ts": `import { makeClient } from "./client";\nconst client = makeClient();\nexport const r = ${call}\n`,
      "local.ts": `import { OpenAIClient } from "./openai";\nconst client = new OpenAIClient();\nexport const r = ${call}\n`,
      "langsmith.ts": `import OpenAI from "openai";\nimport { wrapOpenAI } from "langsmith/wrappers";\nconst client = wrapOpenAI(new OpenAI());\nexport const r = ${call}\n`,
      "port.ts": `import OpenAI from "openai";\nconst client = new OpenAI({ baseURL: "https://api.openai.com:443/v1" });\nexport const r = ${call}\n`,
      "helicone.ts": `import OpenAI from "openai";\nconst client = new OpenAI({ baseURL: "https://oai.helicone.ai/v1" });\nexport const r = ${call}\n`,
      "gateway.ts": `import OpenAI from "openai";\nconst client = new OpenAI({ baseURL: "https://gateway.ai.cloudflare.com/v1/acct/gw/openai" });\nexport const r = ${call}\n`,
      "localhost.ts": `import OpenAI from "openai";\nconst client = new OpenAI({ baseURL: "http://localhost:8080/v1" });\nexport const r = ${call}\n`,
      "instructor.py": "import instructor\nfrom openai import OpenAI\n\nclient = instructor.from_openai(OpenAI())\nr = client.chat.completions.create(model='m', max_tokens=5)\n",
      "langfuse.py": "from langfuse.openai import OpenAI\n\nclient = OpenAI()\nr = client.chat.completions.create(model='m', max_tokens=5)\n",
      "image.js":
        'export const r = fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-4o", max_tokens: 5, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/cat.png" } }] }] }) });\n',
    });
    const { hits, coverage } = await checkReport(dir);
    expect(maxTokens(hits)).toEqual([
      "factory.ts:3",
      "gateway.ts:3",
      "helicone.ts:3",
      "image.js:1",
      "instructor.py:5",
      "langfuse.py:4",
      "langsmith.ts:4",
      "local.ts:3",
      "localhost.ts:3",
      "port.ts:3",
    ]);
    expect(coverage.foreign).toBeUndefined();
  });

  it("only sees assignments the call can reach: same scope, or same class for this/self", async () => {
    const dir = await scratch({
      "scopes.ts":
        'import OpenAI from "openai";\nimport Groq from "groq-sdk";\nconst client = new OpenAI();\nfunction helper() {\n  const client = new Groq();\n  return client;\n}\nexport function main() {\n  return client.chat.completions.create({ model: "m", messages: [], max_tokens: 5 });\n}\nexport { helper };\n',
      "field.ts":
        'import OpenAI from "openai";\nimport Groq from "groq-sdk";\nconst client = new OpenAI();\nclass G {\n  client = new Groq();\n}\nexport const r = client.chat.completions.create({ model: "m", messages: [], max_tokens: 5 });\nexport { G };\n',
      "scopes.py":
        "from openai import OpenAI\nfrom groq import Groq\n\nclient = OpenAI()\n\ndef helper():\n    client = Groq()\n    return client\n\ndef main():\n    return client.chat.completions.create(model='m', max_tokens=5)\n",
    });
    expect(maxTokens(await check(dir))).toEqual(["field.ts:7", "scopes.py:11", "scopes.ts:9"]);
  });

  it("only calls a client foreign when the syntax leaves no doubt", async () => {
    const call = 'client.chat.completions.create({ model: "m", messages: [], max_tokens: 5 });';
    const dir = await scratch({
      // A commented-out look-alike address is not the address.
      "comment.ts": `import OpenAI from "openai";\nconst client = new OpenAI({\n  // baseURL: "https://openrouter.ai/api/v1",\n  apiKey: process.env.KEY,\n});\nexport const r = ${call}\n`,
      "comment.py":
        'from openai import OpenAI\n\nclient = OpenAI(\n    # base_url="https://api.deepseek.com",\n    api_key="k",\n)\nr = client.chat.completions.create(model="m", max_tokens=5)\n',
      // Either branch could run: not certainly a look-alike.
      "branch.ts": `import OpenAI from "openai";\nimport Groq from "groq-sdk";\nlet client;\nif (process.env.P === "openai") client = new OpenAI(); else client = new Groq();\nexport const r = ${call}\n`,
      "tryimport.py":
        "try:\n    from openai import OpenAI as Client\nexcept ImportError:\n    from groq import Groq as Client\n\nclient = Client()\nr = client.chat.completions.create(model='m', max_tokens=5)\n",
      // A parameter shadows the module-level look-alike.
      "param.ts": `import OpenAI from "openai";\nimport Groq from "groq-sdk";\nconst client = new Groq();\nexport async function ask(client: OpenAI) {\n  return ${call}\n}\n`,
      "block.ts": `import OpenAI from "openai";\nimport Groq from "groq-sdk";\nconst client = new OpenAI();\n{\n  const client = new Groq();\n}\nexport const r = ${call}\n`,
      // Imports in comments, strings and docstrings are not imports.
      "fakeimport.ts": `import OpenAI from "openai";\n// import OpenAI from "groq-sdk";\nconst s = \`import OpenAI from "groq-sdk"\`;\nconst client = new OpenAI();\nexport const r = ${call}\n`,
      "docstring.py":
        'from openai import OpenAI\n\n"""\nfrom groq import Groq as OpenAI\n"""\nclient = OpenAI()\nr = client.chat.completions.create(model="m", max_tokens=5)\n',
      // Python scoping: class attributes aren't bare names; global assignments are module-level.
      "classattr.py":
        "from openai import OpenAI\nfrom groq import Groq\n\nclient = OpenAI()\n\nclass A:\n    client = Groq()\n\n    def run(self):\n        return client.chat.completions.create(model='m', max_tokens=5)\n",
      "global.py":
        "from openai import OpenAI\nfrom groq import Groq\n\nclient = Groq()\n\ndef init():\n    global client\n    client = OpenAI()\n\ndef run():\n    return client.chat.completions.create(model='m', max_tokens=5)\n",
    });
    const { hits, coverage } = await checkReport(dir);
    expect(maxTokens(hits)).toEqual([
      "block.ts:7",
      "branch.ts:5",
      "classattr.py:10",
      "comment.py:7",
      "comment.ts:6",
      "docstring.py:7",
      "fakeimport.ts:5",
      "global.py:11",
      "param.ts:5",
      "tryimport.py:7",
    ]);
    expect(coverage.foreign).toBeUndefined();
  });

  it("does not crash on deeply nested files", async () => {
    const deep = `export const s = ${Array.from({ length: 12000 }, (_, i) => `"p${i}"`).join(" + ")};\n`;
    const dir = await scratch({
      "deep.js": `import OpenAI from "openai";\nconst client = new OpenAI();\n${deep}export const r = client.chat.completions.create({ model: "m", messages: [], max_tokens: 5 });\n`,
    });
    expect(maxTokens(await check(dir))).toEqual(["deep.js:4"]);
  });

  it("still catches look-alikes written in less common ways", async () => {
    const dir = await scratch({
      "multiline.py": "from groq import (\n    Groq,\n)\n\nc = Groq()\nr = c.chat.completions.create(model='m', max_tokens=5)\n",
      "fstring.py": 'from openai import OpenAI\n\nc = OpenAI(base_url=f"https://api.groq.com/openai/v1")\nr = c.chat.completions.create(model="m", max_tokens=5)\n',
      "modules.py": "import os, groq\n\nc = groq.Groq()\nr = c.chat.completions.create(model='m', max_tokens=5)\n",
      "constant.ts":
        'import OpenAI from "openai";\nconst BASE = "https://api.groq.com/openai/v1";\nconst c = new OpenAI({ baseURL: BASE });\nexport const r = c.chat.completions.create({ model: "m", messages: [], max_tokens: 5 });\n',
      "classattr_self.py":
        "from groq import Groq\n\nclass B:\n    client = Groq()\n\n    def run(self):\n        return self.client.chat.completions.create(model='m', max_tokens=5)\n",
      "optional.ts":
        'import Groq from "groq-sdk";\nconst client = new Groq();\nexport const r = client?.chat.completions.create({ model: "m", messages: [], max_tokens: 5 });\n',
      "paren.ts":
        'import OpenAI from "openai";\nexport const r = (new OpenAI({ baseURL: "https://openrouter.ai/api/v1" })).chat.completions.create({ model: "m", messages: [], max_tokens: 5 });\n',
      "requests.py":
        'import requests\n\nr = requests.post(f"https://openrouter.ai/api/v1/chat/completions", json=dict(model="m", max_tokens=5))\n',
      "shorthand.ts":
        'import OpenAI from "openai";\nconst baseURL = "https://openrouter.ai/api/v1";\nconst c = new OpenAI({ baseURL });\nexport const r = c.chat.completions.create({ model: "m", messages: [], max_tokens: 5 });\n',
    });
    const { hits, coverage } = await checkReport(dir);
    expect(maxTokens(hits)).toEqual([]);
    expect(coverage.foreign).toBe(9);
  });

  it("follows the client declared in the nearest block, a require with .default, and Volcengine's host", async () => {
    const dir = await scratch({
      "blocks.ts": [
        'import Anthropic from "@anthropic-ai/sdk";',
        'import Groq from "groq-sdk";',
        'import OpenAI from "openai";',
        "export async function ask(provider: string) {",
        '  if (provider === "openai") {',
        "    const client = new OpenAI();",
        '    return client.chat.completions.create({ model: "m", messages: [], max_tokens: 5 });',
        "  }",
        '  if (provider === "groq") {',
        "    const client = new Groq();",
        '    return client.chat.completions.create({ model: "m", messages: [], max_tokens: 5 });',
        "  }",
        "  const client = new Anthropic();",
        '  return client.messages.create({ model: "m", messages: [], max_tokens: 5 });',
        "}",
        "",
      ].join("\n"),
      "lazy.ts": [
        "let Groq: any;",
        "try {",
        '  Groq = require("groq-sdk").default;',
        "} catch {}",
        "export class Provider {",
        "  private client: any = null;",
        "  constructor() {",
        "    this.client = new Groq();",
        "  }",
        "  run() {",
        '    return this.client.chat.completions.create({ model: "m", messages: [], max_tokens: 5 });',
        "  }",
        "}",
        "",
      ].join("\n"),
      "hoisted.js": [
        'import Groq from "groq-sdk";',
        'import OpenAI from "openai";',
        "export function a(xs) {",
        "  var client = new OpenAI();",
        "  for (const x of xs) {",
        '    client.chat.completions.create({ model: "m", messages: [], max_tokens: 5 });',
        "    var client = new Groq();",
        "  }",
        "}",
        "export function b(x) {",
        "  var client = new Groq();",
        "  if (x) {",
        "    var client = new OpenAI();",
        "  }",
        '  return client.chat.completions.create({ model: "m", messages: [], max_tokens: 5 });',
        "}",
        "",
      ].join("\n"),
      "ark.js":
        'export const r = fetch("https://ark.cn-beijing.volces.com/api/v3/images/generations", { method: "POST", body: JSON.stringify({ model: "m", response_format: "url" }) });\n',
    });
    const { hits, coverage } = await checkReport(dir);
    expect(locations(hits)).toEqual(["blocks.ts:7", "hoisted.js:6", "hoisted.js:15"]);
    expect(coverage.foreignAt).toEqual(["ark.js:1", "blocks.ts:11", "lazy.ts:11"]);
  });

  it("reports only the OpenAI call in a file that also uses a look-alike", async () => {
    const dir = await scratch({
      "both.ts":
        'import OpenAI from "openai";\nimport Groq from "groq-sdk";\nconst openai = new OpenAI();\nconst groq = new Groq();\nexport const a = openai.chat.completions.create({ model: "x", messages: [], max_tokens: 5 });\nexport const b = groq.chat.completions.create({ model: "x", messages: [], max_tokens: 5 });\n',
    });
    const { hits, coverage } = await checkReport(dir);
    expect(maxTokens(hits)).toEqual(["both.ts:5"]);
    expect(coverage.foreign).toBe(1);
  });
});

describe("check judges each client by the vendor of the record", () => {
  it("does not reuse one vendor's verdict on a client for a record of another vendor in the same file", async () => {
    const record = (await loadRecords()).map((l) => l.record).find((r) => r.id.includes("max-tokens"))!;
    const other = { ...record, id: `${record.id}-other`, vendor: "anthropic" };
    const dir = await scratch({ "app.ts": 'import Groq from "groq-sdk";\nconst client = new Groq();\nclient.chat.completions.create({ max_tokens: 5 });\n' });
    const { hits, foreign } = await scan(dir, ["app.ts"], [record, other]);
    // A look-alike of OpenAI's client, and nothing this file shows ties it to the other vendor's look-alikes.
    expect(foreign.map((h) => h.record.id)).toEqual([record.id]);
    expect(hits.map((h) => h.record.id)).toEqual([other.id]);
  });
});

describe("check reads raw HTTP calls by their URL argument only", () => {
  const maxTokens = (hits: Hit[]) => locations(hits.filter((h) => h.record.id.includes("max-tokens")));
  const body = "{ method: \"POST\", body: JSON.stringify({ model: \"m\", max_tokens: 5 }) }";

  it("still reports every common way of writing the URL", async () => {
    const dir = await scratch({
      "template.js": `const base = "https://api.openai.com";\nexport const r = fetch(\`\${base}/v1/chat/completions\`, ${body});\n`,
      "concat.js": `const BASE = "https://api.openai.com";\nexport const r = fetch(BASE + "/v1/chat/completions", ${body});\n`,
      "cast.ts": `const b = "https://api.openai.com";\nexport const r = fetch(\`\${b}/v1/chat/completions\` as string, ${body});\n`,
      "newurl.ts": `const base = "https://api.openai.com";\nexport const r = fetch(new URL("/v1/chat/completions", base), ${body});\n`,
      "inner.js": `export async function ask() {\n  return fetch("https://api.openai.com/v1/chat/completions", ${body});\n}\n`,
      "axios.js": 'import axios from "axios";\nexport const r = axios({ url: "https://api.openai.com/v1/chat/completions", data: { max_tokens: 5 } });\n',
      "axiospost.js": 'import axios from "axios";\nexport const r = axios.post("https://api.openai.com/v1/chat/completions", { max_tokens: 5 });\n',
      "fstring.py": 'import requests\n\nbase = "https://api.openai.com"\nr = requests.post(f"{base}/v1/chat/completions", json=dict(max_tokens=5))\n',
      "method.py": 'import requests\n\nr = requests.request("POST", "https://api.openai.com/v1/chat/completions", json=dict(max_tokens=5))\n',
      "split.py": 'import requests\n\nr = requests.post(("https://api.openai.com"\n                   "/v1/chat/completions"), json=dict(max_tokens=5))\n',
      "percent.py": 'import requests\n\nbase = "https://api.openai.com"\nr = requests.post("%s/v1/chat/completions" % base, json=dict(max_tokens=5))\n',
      "keyword.py": 'import httpx\n\nr = httpx.post(url="https://api.openai.com/v1/chat/completions", json=dict(max_tokens=5))\n',
      "ternary.js": `export const r = fetch(proxy ? proxy : "https://api.openai.com/v1/chat/completions", ${body});\n`,
      "ternary.py": 'import requests\n\nr = requests.post(P if P else "https://api.openai.com/v1/chat/completions", json=dict(max_tokens=5))\n',
      "comment.js": `export const r = fetch((/* main */ "https://api.openai.com/v1/chat/completions"), ${body});\n`,
    });
    expect(maxTokens(await check(dir))).toEqual([
      "axios.js:2",
      "axiospost.js:2",
      "cast.ts:2",
      "comment.js:1",
      "concat.js:2",
      "fstring.py:4",
      "inner.js:2",
      "keyword.py:3",
      "method.py:3",
      "newurl.ts:2",
      "percent.py:4",
      "split.py:4",
      "template.js:2",
      "ternary.js:1",
      "ternary.py:3",
    ]);
  });

  it("does not treat a call as a request because an endpoint appears somewhere around it", async () => {
    const dir = await scratch({
      "suite.test.ts": [
        'describe("meta", () => {',
        '  const url = "https://api.meta.ai/v1/chat/completions";',
        "  it(\"rejects\", () => service.chat({ functions: [], max_tokens: 5 }));",
        "});",
        "",
      ].join("\n"),
      "bundle.js": '(function () {\n  const tts = { endpoint: "/v1/chat/completions", payload: { max_tokens: 5 } };\n  register(tts);\n})();\n',
      "route.js": 'app.post("/v1/chat/completions", (req, res) => res.json({ model: "m", max_tokens: 5 }));\n',
      "msw.ts": 'export const h = http.post("https://api.openai.com/v1/chat/completions", () => HttpResponse.json({ max_tokens: 5 }));\n',
      "mock.test.ts": [
        'it("posts", async () => {',
        "  const f = vi.fn(async (input, init) => {",
        '    expect(String(input)).toBe("https://api.openai.com/v1/chat/completions");',
        "    expect(JSON.parse(init.body)).toMatchObject({ max_tokens: 5 });",
        "  });",
        "});",
        "",
      ].join("\n"),
      "fixture.ts": 'writeFixture("mistral", { request: { url: "https://api.mistral.ai/v1/chat/completions", json: { max_tokens: 48 } } });\n',
      "title.js": 'log("sending to /v1/chat/completions", { max_tokens: 5 });\n',
      "helper.js": 'track(`${route("/v1/chat/completions")}`, { max_tokens: 5 });\n',
      "registry.py": 'from functools import partial\n\nm = partial(api.GPT4V, model="o1", api_base="http://0.0.0.0:23333/v1/chat/completions", max_tokens=16384)\n',
    });
    expect(maxTokens(await check(dir))).toEqual([]);
  });

  it("judges the provider by the URL argument, wherever it sits", async () => {
    const dir = await scratch({
      "method.py": 'import requests\n\nr = requests.request("POST", "https://openrouter.ai/api/v1/chat/completions", json=dict(max_tokens=5))\n',
    });
    const { hits, coverage } = await checkReport(dir);
    expect(maxTokens(hits)).toEqual([]);
    expect(coverage.foreign).toBe(1);
  });
});

describe.skipIf(process.platform === "win32")("check prints crafted file and folder names on one line", () => {
  const call = "import OpenAI from 'openai';\nawait new OpenAI().chat.completions.create({ model: 'gpt-4', max_tokens: 5 });\n";
  const lines = (text: string) => text.split("\n");

  it("cannot forge the headline or a GitHub Actions command with a folder name", async () => {
    const dir = await scratch({
      "e\nNo known vendor changes affect this repository./build/x.js": "",
      "x\n::error title=t::text/build/x.js": "",
      "big\n::warning::.json": "x".repeat(MAX_FILE_BYTES + 1),
    });
    const { hits, coverage } = await checkReport(dir);
    const text = render(hits, coverage);
    expect(lines(text)).not.toContain("No known vendor changes affect this repository.");
    expect(lines(text).filter((l) => l.startsWith("::"))).toEqual([]);
    expect(text).toContain("e?No known vendor changes affect this repository./build");
    expect(text).toContain("x?::error title=t::text/build");
    expect(text).toContain("big?::warning::.json");
  });

  it("keeps a call site, value and mention in a crafted file name on one line", async () => {
    const dir = await scratch({
      "a\n::error::b.ts": call,
      "\u202Egpj.ts": call,
      "m\r::warning::.md": "gpt-4\n",
      "v\t::notice::.py": 'MODEL = "gpt-4"\n',
      "local.ts": 'import OpenAI from "openai";\nconst c = new OpenAI({ baseURL: "http://localhost:1\u202Eabc/v1" });\nawait c.chat.completions.create({ model: "x", max_tokens: 5 });\n',
    });
    const { hits, coverage, values, mentions } = await checkReport(dir);
    expect(hits.length).toBeGreaterThan(0);
    for (const all of [false, true]) {
      const text = render(hits, coverage, values, mentions, all);
      expect(lines(text).filter((l) => l.startsWith("::"))).toEqual([]);
      expect(text).not.toMatch(/[\r\t\u202E]/);
      expect(text).toContain("a?::error::b.ts:2:");
      expect(text).toContain("\\u202egpj.ts:2:");
      expect(text).toContain("m?::warning::.md");
    }
    expect(render(hits, coverage, values, mentions)).toContain("v?::notice::.py:1:");
    expect(render(hits, coverage, values, mentions)).toContain("(sent to localhost:1\\u202eabc;");
    const json = JSON.parse([...checkJson({ version: "t" }, { hits, possiblyAffected: values, mentions })].join("")) as { hits: { file: string }[] };
    expect(json.hits.map((h) => h.file)).toContain("a\n::error::b.ts");
  });

  it("escapes direction-changing and C1 characters in every part of the JSON report", () => {
    const report = { version: "t", scanned: { files: 1, records: 1, tooLarge: ["\u202Ex\u2066\u009b.ts", "café 日本 🎉.ts"] } };
    const text = [...checkJson(report, { hits: [], possiblyAffected: [], mentions: [] })].join("");
    expect(text).not.toMatch(/[\u0080-\u009f\u202e\u2066]/);
    expect(text).toContain(String.raw`"\u202ex\u2066\u009b.ts"`);
    expect(JSON.parse(text)).toEqual({ ...report, hits: [], possiblyAffected: [], mentions: [] });
  });

  it("writes a long escaped line of the JSON report in pieces, never as one string", async () => {
    const record = (await loadRecords())[0]!.record;
    const hit = { record, file: "app.ts", line: 1, column: 1, text: "\u202E".repeat(200_000) } as unknown as Hit;
    const chunks = [...checkJson({ version: "t" }, { hits: [hit], possiblyAffected: [], mentions: [] })];
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(6 * 8_192);
    expect((JSON.parse(chunks.join("")) as { hits: { text: string }[] }).hits[0]!.text).toBe(hit.text);
  });
});

describe("escapeHidden", () => {
  const cp = (...points: number[]) => String.fromCodePoint(...points);
  const units = (s: string) => s.split("").map((u) => `\\u${u.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  const tags = (s: string) => cp(...[...s].map((c) => 0xe0000 + c.charCodeAt(0)));
  const [ZWJ, VS16] = ["\u200D", "\uFE0F"];

  it.each([
    0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202e,
    0x2028, 0x2029, 0x2060, 0x2064, 0x2066, 0x2069, 0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f, 0x3164, 0xfe00, 0xfe0e,
    0xfe0f, 0xfeff, 0xffa0, 0x007f, 0x0085, 0x009b, 0xe0000, 0xe0001, 0xe0020, 0xe0041, 0xe007f, 0xe0100, 0x1d173,
  ])("writes out U+%s, which can hide or reorder text", (point) => {
    const text = `a${cp(point)}b`;
    expect(escapeHidden(text)).toBe(`a${units(cp(point))}b`);
    expect(JSON.parse(`"${escapeHidden(text)}"`)).toBe(text);
  });

  it("writes out tag characters that spell hidden text, and a joiner or U+FE0F anywhere but inside an emoji", () => {
    expect(escapeHidden(`app${tags("delete prod db")}.ts`)).toBe(`app${units(tags("delete prod db"))}.ts`);
    expect(escapeHidden(`a${ZWJ}b`)).toBe("a\\u200db");
    expect(escapeHidden(`${cp(0x1f44d)}${ZWJ}X`)).toBe(`${cp(0x1f44d)}\\u200dX`);
    expect(escapeHidden(`${cp(0x1f468)}${ZWJ}${ZWJ}${cp(0x1f469)}`)).toBe(`${cp(0x1f468)}\\u200d\\u200d${cp(0x1f469)}`);
    expect(escapeHidden(`a${ZWJ.repeat(5)}b`)).toBe(`a${"\\u200d".repeat(5)}b`);
    expect(escapeHidden(`a${VS16}`)).toBe("a\\ufe0f");
    // Only England, Scotland and Wales have flags: any other tags in the shape of one could spell a word.
    for (const code of ["evil", "usca", "gbeng1", "gbe", "g b", "GBENG", "deleteproddb"]) expect(escapeHidden(`${cp(0x1f3f4)}${tags(code)}${cp(0xe007f)}`)).toBe(`${cp(0x1f3f4)}${units(tags(code) + cp(0xe007f))}`);
    // A tag right after a whole flag is not part of it.
    expect(escapeHidden(`${cp(0x1f3f4)}${tags("gbsct")}${cp(0xe007f, 0xe0041)}`)).toBe(`${cp(0x1f3f4)}${tags("gbsct")}${cp(0xe007f)}${units(cp(0xe0041))}`);
  });

  it("keeps a joiner after a pictograph, a skin tone and U+FE0F, and before a pictograph, and only there", () => {
    for (let tone = 0x1f3fb; tone <= 0x1f3ff; tone++) {
      const coder = `${cp(0x1f469, tone)}${ZWJ}${cp(0x1f4bb)}`;
      expect(escapeHidden(coder)).toBe(coder);
      // U+FE0F after a skin tone is in no emoji, so it is written out; the joiner after both still stays.
      expect(escapeHidden(`${cp(0x1f3cc, tone)}${VS16}${ZWJ}${cp(0x2640)}${VS16}`)).toBe(`${cp(0x1f3cc, tone)}\\ufe0f${ZWJ}${cp(0x2640)}${VS16}`);
      expect(escapeHidden(`a${cp(tone)}${ZWJ}${cp(0x1f4bb)}`)).toBe(`a${cp(tone)}\\u200d${cp(0x1f4bb)}`);
      expect(escapeHidden(`${cp(0x1f469, tone)}${ZWJ}a`)).toBe(`${cp(0x1f469, tone)}\\u200da`);
    }
    expect(escapeHidden(`${cp(0x1f3cc)}${VS16}${ZWJ}${cp(0x2640)}${VS16}`)).toBe(`${cp(0x1f3cc)}${VS16}${ZWJ}${cp(0x2640)}${VS16}`);
  });

  it("judges pictographs by a fixed list, the same on every Node version", () => {
    // U+2605 and U+1F0A1 are pictographs in Unicode 16.0 and not in 17.0; Node ships one or the other depending on its version.
    const symbols = `${cp(0x2605)}${ZWJ}${cp(0x1f0a1)}${VS16}`;
    expect(escapeHidden(symbols)).toBe(symbols);
  });

  it.each([
    ["family", `${cp(0x1f468)}${ZWJ}${cp(0x1f469)}${ZWJ}${cp(0x1f467)}${ZWJ}${cp(0x1f466)}`],
    ["skin tone", cp(0x1f44d, 0x1f3fd)],
    ["skin tone and joiner", `${cp(0x1f469, 0x1f3fd)}${ZWJ}${cp(0x1f4bb)}`],
    ["emoji presentation", `${cp(0x2764)}${VS16}`],
    ["flag and joiner", `${cp(0x1f3f3)}${VS16}${ZWJ}${cp(0x1f308)}`],
    ["joiner then U+FE0F", `${cp(0x1f3f4)}${ZWJ}${cp(0x2620)}${VS16}`],
    ["kiss", `${cp(0x1f469)}${ZWJ}${cp(0x2764)}${VS16}${ZWJ}${cp(0x1f48b)}${ZWJ}${cp(0x1f468)}`],
    ["gender", `${cp(0x1f3c3)}${ZWJ}${cp(0x2640)}${VS16}`],
    ["hair", `${cp(0x1f468)}${ZWJ}${cp(0x1f9b0)}`],
    ["England flag", `${cp(0x1f3f4)}${tags("gbeng")}${cp(0xe007f)}`],
    ["Scotland flag", `${cp(0x1f3f4)}${tags("gbsct")}${cp(0xe007f)}`],
    ["Wales flag", `${cp(0x1f3f4)}${tags("gbwls")}${cp(0xe007f)}`],
    ["keycap", `1${VS16}\u20E3`],
    ["country flag", cp(0x1f1fa, 0x1f1f8)],
  ])("keeps the %s emoji whole", (_name, emoji) => {
    expect(escapeHidden(`a ${emoji} b`)).toBe(`a ${emoji} b`);
    expect([...escapedPieces(`${"x".repeat(8_190)}${emoji}`)].join("")).toBe(`${"x".repeat(8_190)}${emoji}`);
  });
});

describe("escapedPieces", () => {
  it("escapes as escapeHidden does, in pieces that never cut a character in two", () => {
    const text = `${"a".repeat(8_191)}🎉\u202E${"b".repeat(8_190)}👨\u200D👩${"\u2066".repeat(70_000)}`;
    const pieces = [...escapedPieces(text)];
    expect(pieces.length).toBeGreaterThan(2);
    expect(pieces.join("")).toBe(escapeHidden(text));
    // Each piece is written on its own, and a lone half of an emoji would be written as U+FFFD.
    for (const piece of pieces) expect(Buffer.from(piece).toString()).toBe(piece);
    expect(Math.max(...pieces.map((p) => p.length))).toBeLessThanOrEqual(6 * 8_192);
    expect([...escapedPieces("")]).toEqual([]);
  });
});

describe("snippet", () => {
  it("marks code that was cut off, by length or by line, and leaves short code alone", () => {
    expect(snippet("max_tokens: 256")).toBe("max_tokens: 256");
    const long = 'functions: [{ name: "get_weather", parameters: { type: "object", properties: {} } }]';
    expect(snippet(long)).toBe('functions: [{ name: "get_weather", parameters: { type: "obj…');
    expect(snippet(long)).toHaveLength(60);
    expect(snippet("functions: [\n  { name: \"x\" },\n]")).toBe("functions: […");
  });
});

describe("check", () => {
  it("reports what it covered, counting only files it can parse", async () => {
    const dir = await scratch({ "a.js": "export const x = 1;\n", "b.py": "x = 1\n", "notes.md": "# hi\n" });
    const { hits, coverage } = await checkReport(dir);
    expect(hits).toEqual([]);
    expect(coverage.files).toBe(2);
    expect(coverage.records).toBeGreaterThanOrEqual(2);
  });

  it("skips a copy of OpenAI's Python library bundled inside the project", async () => {
    const call = "def create(self, *, max_tokens=None, functions=None):\n    return self._post(max_tokens=max_tokens)\n";
    const dir = await scratch({
      "app.py": "from openai import OpenAI\n\nr = OpenAI().chat.completions.create(model='m', max_tokens=5)\n",
      "lib/adapted_openai/_base_client.py": "class SyncAPIClient: ...\n",
      "lib/adapted_openai/_client.py": "class OpenAI: ...\n",
      "lib/adapted_openai/_exceptions.py": "class APIError(Exception): ...\n",
      "lib/adapted_openai/resources/chat/completions.py": `from openai import OpenAI\n\nclient = OpenAI()\nr = client.chat.completions.create(model='m', max_tokens=5)\n${call}`,
      "lib/other/_client.py": "from openai import OpenAI\n\nr = OpenAI().chat.completions.create(model='m', max_tokens=5)\n",
    });
    const { hits, coverage } = await checkReport(dir);
    expect(locations(hits.filter((h) => h.record.id.includes("max-tokens")))).toEqual(["app.py:3", "lib/other/_client.py:3"]);
    expect(coverage.files).toBe(2);
  });

  it("names the dependency, build and bundled SDK folders it skips", async () => {
    const call = "import OpenAI from 'openai';\nawait new OpenAI().chat.completions.create({ model: 'm', max_tokens: 5 });\n";
    const dir = await scratch({
      "src/vendor/openai.ts": call,
      "node_modules/openai/index.js": call,
      "packages/a/node_modules/x/index.js": call,
      ".git/config": "",
      ".git/x.ts": call,
      "lib/adapted_openai/_base_client.py": "",
      "lib/adapted_openai/_client.py": "",
      "lib/adapted_openai/_exceptions.py": "",
    });
    const { hits, coverage } = await checkReport(dir);
    expect(hits).toEqual([]);
    expect(coverage.skipped).toEqual([
      { path: "lib/adapted_openai", reason: "bundled SDK copy" },
      { path: "node_modules", reason: "dependency or build folder" },
      { path: "packages/a/node_modules", reason: "dependency or build folder" },
      { path: "src/vendor", reason: "dependency or build folder" },
    ]);
    const text = render(hits, coverage);
    expect(text).toContain("\nNot checked: 3 dependency or build folders: node_modules, packages/a/node_modules, src/vendor.\n");
    expect(text).toContain("\nNot checked: 1 folder with a bundled copy of an SDK: lib/adapted_openai.\n");
    expect(text).not.toContain(".git");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("names the folders and files it could not read", async () => {
    const call = "import OpenAI from 'openai';\nawait new OpenAI().chat.completions.create({ model: 'm', max_tokens: 5 });\n";
    const dir = await scratch({ "b.ts": call, "src/secret/openai.ts": call, "src/listed/openai.ts": call });
    const locked = ["b.ts", "src/secret", "src/listed"];
    await chmod(join(dir, "b.ts"), 0o000);
    await chmod(join(dir, "src/secret"), 0o000);
    await chmod(join(dir, "src/listed"), 0o644);
    try {
      const { hits, coverage } = await checkReport(dir);
      expect(hits).toEqual([]);
      expect(coverage.skipped).toEqual([
        { path: "b.ts", reason: "could not be read" },
        { path: "src/listed/openai.ts", reason: "could not be read" },
        { path: "src/secret", reason: "could not be read" },
      ]);
      expect(render(hits, coverage)).toContain("\nNot checked: could not read b.ts, src/listed/openai.ts, src/secret.\n");
    } finally {
      for (const p of locked) await chmod(join(dir, p), 0o755);
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("names the repository folder when it cannot be read", async () => {
    const dir = await scratch({ "a.js": "" });
    await chmod(dir, 0o000);
    try {
      const { coverage } = await checkReport(dir);
      expect(render([], coverage)).toContain("\nNot checked: could not read the repository folder.\n");
    } finally {
      await chmod(dir, 0o755);
    }
  });

  it.skipIf(process.platform === "win32")("names symbolic links to outside the repository, not links inside it", async () => {
    const call = "import OpenAI from 'openai';\nawait new OpenAI().chat.completions.create({ model: 'm', max_tokens: 5 });\n";
    const outside = await scratch({ "shared/openai.ts": call, "one.ts": call });
    const dir = await scratch({ "src/app.ts": "export const x = 1;\n" });
    await symlink(join(outside, "shared"), join(dir, "shared"));
    await symlink(join(outside, "one.ts"), join(dir, "src/one.ts"));
    await symlink("src", join(dir, "inside"));
    await symlink("app.ts", join(dir, "src/again.ts"));
    await symlink(join(outside, "missing"), join(dir, "broken"));
    const { hits, coverage } = await checkReport(dir);
    expect(hits).toEqual([]);
    expect(coverage.skipped).toEqual([
      { path: "shared", reason: "symbolic link outside the repository" },
      { path: "src/one.ts", reason: "symbolic link outside the repository" },
    ]);
    expect(render(hits, coverage)).toContain("\nNot checked: 2 symbolic links to outside the repository: shared, src/one.ts.\n");
  });

  it("lists skipped folders in path order", async () => {
    const dir = await scratch({ "b/vendor/x.js": "", "a/vendor/x.js": "", "C/vendor/x.js": "", "a/b/vendor/x.js": "", "a/b/dist/x.js": "" });
    const { coverage } = await checkReport(dir);
    expect(coverage.skipped?.map((s) => s.path)).toEqual(["C/vendor", "a/b/dist", "a/b/vendor", "a/vendor", "b/vendor"]);
  });

  it("says no call sites were found, not that nothing is affected, when something was not checked", () => {
    const clean = { files: 1, records: 1 };
    expect(render([], clean)).toMatch(/^No known vendor changes affect this repository\./);
    expect(render([], { ...clean, skipped: [{ path: "vendor", reason: "dependency or build folder" }] })).toMatch(/^No call sites of known vendor changes found\.\n/);
    expect(render([], { ...clean, tooLarge: ["big.js"] })).toMatch(/^No call sites of known vendor changes found\.\n/);
  });

  it("still scans a generated SDK when it is the folder being checked", async () => {
    const dir = await scratch({
      "_base_client.py": "class SyncAPIClient: ...\n",
      "_client.py": "class OpenAI: ...\n",
      "_exceptions.py": "class APIError(Exception): ...\n",
      "example.py": "from openai import OpenAI\n\nr = OpenAI().chat.completions.create(model='m', max_tokens=5)\n",
    });
    expect(locations(await check(dir))).toEqual(["example.py:3"]);
  });

  it("reports OpenAI call sites and ignores other vendors' max_tokens and nested calls", async () => {
    const hits = await check(MAX_TOKENS_FIXTURE);
    expect(locations(hits)).toEqual(["app.js:12", "app.js:22", "app.py:10", "app.ts:9"]);
    expect(hits.every((h) => h.record.id === "openai:2024-09-12:max-tokens-to-max-completion-tokens")).toBe(true);
  });

  it("finds the one call site in each sample repo", async () => {
    expect(locations(await check(join(SAMPLES, "small")))).toEqual(["index.js:6"]);
    // medium: chat.ts builds its options object separately, which is invisible to the scan
    expect(locations(await check(join(SAMPLES, "medium")))).toEqual(["worker.py:10"]);
    // messy: no SDK, a raw fetch to the endpoint
    expect(locations(await check(join(SAMPLES, "messy")))).toEqual(["lib/client.js:6"]);
  });

  it("follows the call, not the import: wrapper modules and TypeScript casts are still found", async () => {
    const dir = await scratch({
      "wrapped.js": 'import { llm } from "./client.js";\nexport const r = llm.chat.completions.create({ model: "x", max_tokens: 200 });\n',
      "cast.ts": 'import OpenAI from "openai";\nconst c = new OpenAI();\nexport const r = c.chat.completions.create({ model: "x", max_tokens: 1 } as OpenAI.ChatCompletionCreateParams);\n',
    });
    expect(locations(await check(dir))).toEqual(["cast.ts:3", "wrapped.js:2"]);
  });

  it("finds every chat completions entry point in both SDKs, but not legacy completions", async () => {
    const dir = fileURLToPath(new URL("../packs/openai/2024-09-12-max-tokens-to-max-completion-tokens/fixtures/entry-points/before/", import.meta.url));
    const hits = (await check(dir)).filter((h) => h.record.id.includes("max-tokens"));
    expect(locations(hits)).toEqual([
      "app.js:6",
      "app.js:7",
      "app.js:8",
      "app.js:9",
      "app.js:10",
      "app.js:17",
      "app.js:18",
      "app.py:6",
      "app.py:7",
      "app.py:8",
      "app.py:9",
      "app.py:10",
      "app.py:17",
    ]);
  });

  it("reports a shorthand max_tokens in OpenAI calls, not in other calls or destructuring", async () => {
    const dir = fileURLToPath(new URL("../packs/openai/2024-09-12-max-tokens-to-max-completion-tokens/fixtures/shorthand/before/", import.meta.url));
    const hits = (await check(dir)).filter((h) => h.record.id.includes("max-tokens"));
    expect(locations(hits)).toEqual(["app.js:8", "app.js:16", "app.ts:6"]);
  });

  it("reports images user in shorthand, raw-response and raw HTTP calls, not in other calls", async () => {
    const dir = fileURLToPath(new URL("../packs/openai/2026-10-26-user-to-safety-identifier/fixtures/forms/before/", import.meta.url));
    const hits = (await check(dir)).filter((h) => h.record.id.includes("user-to-safety-identifier"));
    expect(locations(hits)).toEqual(["app.js:5", "app.js:6", "app.js:7", "app.py:5", "app.py:6", "app.py:7", "app.py:8", "app.py:9", "app.py:10"]);
  });

  it("reports spend_control sent to the agent session paths with quoted or bare keys, not to other paths", async () => {
    const dir = fileURLToPath(new URL("../packs/openai/2026-10-26-spend-control-removed/fixtures/raw-http/before/", import.meta.url));
    const hits = (await check(dir)).filter((h) => h.record.id.includes("spend-control"));
    expect(locations(hits)).toEqual(["app.js:4", "app.js:5", "app.js:6", "app.js:7", "app.py:5", "app.py:6", "app.py:7", "app.py:8"]);
  });

  it("reports a quoted max_tokens in OpenAI calls and raw chat completions requests, not in other requests, objects or logs", async () => {
    const dir = fileURLToPath(new URL("../packs/openai/2024-09-12-max-tokens-to-max-completion-tokens/fixtures/raw-http/before/", import.meta.url));
    const hits = (await check(dir)).filter((h) => h.record.id.includes("max-tokens"));
    expect(locations(hits)).toEqual(["app.js:8", "app.js:9", "app.js:12", "app.js:13", "app.js:14", "app.py:11", "app.py:12", "app.py:15", "app.py:16", "app.py:17"]);
  });

  it("does not report an options object passed by name", async () => {
    const dir = await scratch({ "detached.js": 'import OpenAI from "openai";\nconst opts = { max_tokens: 5 };\nnew OpenAI().chat.completions.create(opts);\n' });
    expect(await check(dir)).toEqual([]);
    const clean = render([], { files: 1, records: 2 });
    expect(clean).toContain("No known vendor changes affect this repository.");
    expect(clean).toContain("Scanned 1 JavaScript, TypeScript or Python file against 2 change records.");
    expect(clean).toContain("Not checked: request options built elsewhere");
  });

  it("keeps another vendor's max_tokens out of the report even next to a raw OpenAI fetch", async () => {
    const dir = await scratch({
      "router.js": [
        'import Anthropic from "@anthropic-ai/sdk";',
        "export async function viaOpenAI(messages) {",
        '  return fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages, max_tokens: 300 }) });',
        "}",
        "export async function viaAnthropic(messages) {",
        '  return new Anthropic().messages.create({ model: "claude-sonnet-5", max_tokens: 1024, messages });',
        "}",
        "",
      ].join("\n"),
    });
    expect(locations(await check(dir))).toEqual(["router.js:3"]);
  });

  it("only reports vendors listed in darnit.yml when the file lists any", async () => {
    const source = 'import OpenAI from "openai";\nexport const r = new OpenAI().chat.completions.create({ model: "x", max_tokens: 1 });\n';
    const stripeOnly = await scratch({ "app.js": source, "darnit.yml": "version: 1\napis:\n  stripe:\n    tier: recognized\n" });
    expect(await check(stripeOnly)).toEqual([]);
    const openai = await scratch({ "app.js": source, "darnit.yml": "version: 1\napis:\n  openai:\n    tier: supported\n" });
    expect(locations(await check(openai))).toEqual(["app.js:2"]);
  });

  it("renders a grouped report with locations, counts and the citation", async () => {
    const hits = await check(join(SAMPLES, "medium"));
    const text = render(hits);
    expect(text).toContain("openai 2024-09-12: Rename max_tokens to max_completion_tokens on chat completions");
    expect(text).toContain("worker.py:10:9");
    expect(text).toContain("1 call site in 1 file");
    expect(text).toContain("https://developers.openai.com/api/docs/api-reference/chat/create");
    expect(text).toContain("Not checked:");
    expect(render(hits, { files: 3, records: 4 })).toContain("Scanned 3 JavaScript, TypeScript or Python files against 4 change records.");

    const candidate = { ...hits[0]!, record: { ...hits[0]!.record, status: "candidate" as const } };
    expect(render([candidate])).toContain("(unreviewed change, detection only)");
    expect(render([candidate])).toContain("Unreviewed changes are reported but do not fail the check.");
    expect(render(hits)).not.toContain("do not fail the check");

    const parsed = { ...hits[0]!, record: { ...hits[0]!.record, status: "parser-verified" as const } };
    expect(render([parsed])).toContain("(parser-verified, not read by a person)");
    expect(render(hits)).not.toContain("parser-verified");

    // A reviewed or parser-verified change fails the check; a candidate alone never turns a scheduled run red.
    expect(exitCodeForCheck([candidate])).toBe(0);
    expect(exitCodeForCheck([candidate, hits[0]!])).toBe(1);
    expect(exitCodeForCheck([candidate, parsed])).toBe(1);
    expect(exitCodeForCheck([])).toBe(0);

    expect(toJson(hits)).toEqual([
      {
        id: "openai:2024-09-12:max-tokens-to-max-completion-tokens",
        title: "Rename max_tokens to max_completion_tokens on chat completions",
        status: "reviewed",
        vendor: "openai",
        announcedAt: "2024-09-12",
        kind: "deprecation",
        file: "worker.py",
        line: 10,
        column: 9,
        text: "max_tokens=128",
        sources: ["https://developers.openai.com/api/docs/api-reference/chat/create"],
      },
    ]);
  });
});

describe("model shutdowns", () => {
  const shutdowns = (hits: Hit[]) => hits.filter((h) => h.record.id.includes("shut-down"));

  it("marks every shutdown record as parser-verified until a person reviews it", async () => {
    const records = (await loadRecords()).map((l) => l.record).filter((r) => r.id.includes("shut-down"));
    expect(records).toHaveLength(29);
    expect(records.filter((r) => r.status !== "parser-verified").map((r) => r.id)).toEqual([]);
  });

  it("gives every shutdown record the same list of calls that take a model", async () => {
    const [first, ...rest] = (await loadRecords()).map((l) => l.record).filter((r) => r.id.includes("shut-down"));
    expect(rest.filter((r) => JSON.stringify(r.surface.sdkSymbols) !== JSON.stringify(first!.surface.sdkSymbols)).map((r) => r.id)).toEqual([]);
  });

  it("lists every SDK class a record names, so its calls are checked against the class's import", async () => {
    const symbols = (await loadRecords()).flatMap((l) => l.record.surface.sdkSymbols ?? []);
    expect([...new Set(symbols.filter((s) => /^[A-Z]/.test(s)).map((s) => s.split(".")[0]))].filter((c) => !SDK_CLASSES.has(c!))).toEqual([]);
  });

  it("reports a retiring model in each realtime call that takes one", async () => {
    const forms = (s: string) => [s, s.replace(/\.(\w+)$/, ".with_raw_response.$1"), s.replace(/\.(\w+)$/, ".with_streaming_response.$1")];
    const py = ["beta.realtime.sessions.create", "beta.realtime.transcription_sessions.create", "realtime.client_secrets.create", "realtime.calls.create", "realtime.calls.accept", "realtime.translations.client_secrets.create"].flatMap(forms);
    const js = ["beta.realtime.transcriptionSessions.create", "realtime.clientSecrets.create", "realtime.translations.clientSecrets.create"];
    const old = "gpt-4o-realtime-preview-2024-10-01";
    const dir = await scratch({
      "all.py": ["from openai import OpenAI", "client = OpenAI()", ...py.map((s) => `client.${s}(model="${old}")`), ""].join("\n"),
      "all.ts": ['import OpenAI from "openai";', "const openai = new OpenAI();", ...js.map((s) => `openai.${s}({ model: "${old}" });`), ""].join("\n"),
    });
    const found = new Set(shutdowns((await checkReport(dir)).hits).map((h) => `${h.file}:${h.line}`));
    const missed = [...py.map((s, i) => [s, `all.py:${i + 3}`]), ...js.map((s, i) => [s, `all.ts:${i + 3}`])].filter(([, at]) => !found.has(at!)).map(([s]) => s);
    expect(missed).toEqual([]);
  });

  it("reports a retiring model only inside OpenAI calls that take a model, with the date", async () => {
    const dir = await scratch({
      "app.ts": [
        'import OpenAI from "openai";',
        'import Groq from "groq-sdk";',
        "const openai = new OpenAI();",
        "const groq = new Groq();",
        'export const a = await openai.audio.transcriptions.create({ model: "whisper-1", file });',
        'export const b = await groq.audio.transcriptions.create({ model: "whisper-1", file });',
        'export const c = await openai.chat.completions.create({ model: "gpt-4", messages });',
        'log({ model: "gpt-5.1" });',
        'export const d = await openai.responses.create({ model: "gpt-5.1", input });',
        "",
      ].join("\n"),
      "speak.py": 'from openai import OpenAI\n\nclient = OpenAI()\nwith client.audio.speech.with_streaming_response.create(model="tts-1", voice="alloy", input="hi") as r:\n    pass\n',
    });
    const { hits, coverage } = await checkReport(dir);
    expect(locations(shutdowns(hits)).sort()).toEqual(["app.ts:5", "app.ts:7", "app.ts:9", "speak.py:4"]);
    expect(coverage.foreignAt).toEqual(["app.ts:6"]);
    expect(exitCodeForCheck(hits)).toBe(1);
    const text = render(hits, coverage);
    expect(text).toContain("openai 2026-08-26: whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe and 1 more shut down on 2027-02-26");
    expect(text).toContain("openai 2026-04-22: o1, gpt-4, o1-pro, o3-mini, o4-mini, gpt-4-0613 and 17 more shut down on 2026-10-23");
    expect(text).toContain("openai 2026-10-01: gpt-5.1, gpt-5.4-nano and gpt-5.3-codex shut down on 2027-04-01");
    expect(text).toContain("openai 2026-10-01: tts-1, tts-1-hd, gpt-4o-mini-tts-2025-03-20 and 1 more shut down on 2027-01-06");
  });

  it("reports a retiring model in the calls that start a realtime session, not in a look-alike's", async () => {
    const old = "gpt-4o-realtime-preview-2024-10-01";
    const dir = await scratch({
      "session.py": [
        "from openai import OpenAI",
        "from groq import Groq",
        "",
        "client = OpenAI()",
        "groq = Groq()",
        `a = client.beta.realtime.sessions.create(model="${old}")`,
        `b = client.beta.realtime.sessions.with_raw_response.create(model="${old}")`,
        `c = client.realtime.calls.with_streaming_response.accept("call_1", type="realtime", model="${old}")`,
        `d = groq.beta.realtime.sessions.create(model="${old}")`,
        "",
      ].join("\n"),
      "token.ts": [
        'import OpenAI from "openai";',
        "const openai = new OpenAI();",
        `export const a = await openai.realtime.clientSecrets.create({ session: { type: "realtime", model: "${old}" } });`,
        `export const b = await openai.realtime.calls.accept("call_1", { type: "realtime", model: "${old}" });`,
        'export const c = await openai.beta.realtime.transcriptionSessions.create({ input_audio_transcription: { model: "whisper-1" } });',
        "",
      ].join("\n"),
    });
    const { hits, coverage } = await checkReport(dir);
    expect(locations(shutdowns(hits)).sort()).toEqual(["session.py:6", "session.py:7", "session.py:8", "token.ts:3", "token.ts:4", "token.ts:5"]);
    expect(coverage.foreignAt).toEqual(["session.py:9"]);
  });

  it("reports a retiring model passed to a realtime class's create, not to a look-alike class", async () => {
    const old = "gpt-4o-realtime-preview-2024-10-01";
    const classes = [
      ["openai/realtime/ws", "OpenAIRealtimeWS"],
      ["openai/realtime/websocket", "OpenAIRealtimeWebSocket"],
      ["openai/beta/realtime/ws", "OpenAIRealtimeWS"],
      ["openai/beta/realtime/websocket", "OpenAIRealtimeWebSocket"],
      ["openai/realtime/translations/ws", "OpenAIRealtimeTranslationWS"],
    ];
    const files = Object.fromEntries(
      classes.map(([p, cls], i) => [`rt${i}.ts`, ['import OpenAI from "openai";', `import { ${cls} } from "${p}";`, "const client = new OpenAI();", `await ${cls}.create(client, { model: "${old}" });`, ""].join("\n")]),
    );
    const dir = await scratch({
      ...files,
      "cjs.js": ['const OpenAI = require("openai");', 'const { OpenAIRealtimeWS } = require("openai/realtime/ws");', `OpenAIRealtimeWS.create(new OpenAI(), { model: "${old}" });`, ""].join("\n"),
      "groq.ts": [
        'import OpenAI from "openai";',
        'import { OpenAIRealtimeWS } from "openai/realtime/ws";',
        'const groq = new OpenAI({ baseURL: "https://api.groq.com/openai/v1" });',
        `await OpenAIRealtimeWS.create(groq, { model: "${old}" });`,
        "",
      ].join("\n"),
      "other.ts": [
        'import { OpenAIRealtimeWS } from "some-realtime-lib";',
        'import { OpenAIRealtimeTranslationWS } from "openai-realtime-api/realtime/translations/ws";',
        "class OpenAIRealtimeWebSocket {",
        "  static create(client: unknown, props: { model: string }) {}",
        "}",
        `OpenAIRealtimeWS.create(client, { model: "${old}" });`,
        `OpenAIRealtimeWebSocket.create(client, { model: "${old}" });`,
        `OpenAIRealtimeTranslationWS.create(client, { model: "${old}" });`,
        "",
      ].join("\n"),
    });
    const { hits, coverage, values } = await checkReport(dir);
    expect([...new Set(locations(shutdowns(hits)))].sort()).toEqual(["cjs.js:3", "rt0.ts:4", "rt1.ts:4", "rt2.ts:4", "rt3.ts:4", "rt4.ts:4"]);
    expect(coverage.foreignAt).toEqual(["groq.ts:4"]);
    // A look-alike's model is still listed, as possibly affected.
    expect([...new Set(values.map((v) => `${v.file}:${v.line}`))].sort()).toEqual(["other.ts:6", "other.ts:7", "other.ts:8"]);
  });

  it("reports a retiring model under a quoted key in a raw request, not in a config object", async () => {
    const dir = await scratch({
      "raw.py": 'import requests\n\nr = requests.post("https://api.openai.com/v1/chat/completions", json={"model": "gpt-4", "messages": []})\nCONFIG = {"model": "gpt-4"}\n',
      "raw.js": 'export const r = fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ "model": "gpt-4" }) });\nexport const config = { "model": "gpt-4" };\n',
    });
    const { hits, values } = await checkReport(dir);
    expect([...new Set(locations(shutdowns(hits)))].sort()).toEqual(["raw.js:1", "raw.py:3"]);
    expect([...new Set(values.map((v) => `${v.file}:${v.line}`))].sort()).toEqual(["raw.js:2", "raw.py:4"]);
  });

  it("reports a retiring model written as the fallback when no model is passed", async () => {
    const dir = await scratch({
      "stt.ts": [
        'import OpenAI from "openai";',
        'import Groq from "groq-sdk";',
        "const openai = new OpenAI();",
        "const groq = new Groq();",
        "export const a = (o) => openai.audio.transcriptions.create({ file, model: o.model ?? 'whisper-1' });",
        'export const b = (o) => openai.audio.transcriptions.create({ file, model: o.model || "whisper-1" });',
        'export const c = (o) => openai.chat.completions.create({ messages, model: o.model ?? o.fallback ?? "gpt-4" });',
        'export const d = (o) => groq.audio.transcriptions.create({ file, model: o.model ?? "whisper-1" });',
        'export const e = (o) => openai.chat.completions.create({ messages, model: o.model ?? "gpt-4o" });',
        "",
      ].join("\n"),
      "stt.py": 'from openai import OpenAI\n\nclient = OpenAI()\n\ndef run(opts):\n    return client.audio.transcriptions.create(file=f, model=opts.model or "whisper-1")\n',
    });
    const { hits, coverage } = await checkReport(dir);
    expect(locations(shutdowns(hits)).sort()).toEqual(["stt.py:6", "stt.ts:5", "stt.ts:6", "stt.ts:7"]);
    expect(coverage.foreignAt).toEqual(["stt.ts:8"]);
  });
});

describe("model names set as values", () => {
  const MODEL_VALUES = join(SAMPLES, "model-values");

  it("lists each kind of value once, outside tests and tokenizers, without failing the check", async () => {
    const { hits, values, coverage } = await checkReport(MODEL_VALUES);
    expect(locations(hits)).toEqual(["src/call.ts:6"]);
    expect(coverage.foreignAt).toEqual(["src/call.ts:7"]);
    expect(values.map((v) => `${v.file}:${v.line}:${v.model}`).sort()).toEqual(
      [
        "examples/agent.ts:3:gpt-3.5-turbo",
        "src/config.ts:1:gpt-4-turbo",
        "src/config.ts:2:tts-1",
        "src/config.ts:5:gpt-4",
        "src/config.ts:6:text-davinci-003",
        "src/config.ts:8:o3-mini",
        "src/config.ts:12:o1-mini",
        "src/config.ts:16:whisper-1",
        "src/config.ts:17:dall-e-3",
        "src/config.ts:21:gpt-4-32k",
        "src/config.ts:23:gpt-3.5-turbo-0613",
        "src/config.ts:27:gpt-3.5-turbo",
        "src/config.ts:28:gpt-4",
        "src/config.ts:29:gpt-4",
        "src/defaults.py:4:gpt-4-turbo",
        "src/defaults.py:9:gpt-4",
        "src/defaults.py:10:text-similarity-ada-001",
        "src/defaults.py:14:o3-mini",
        "src/defaults.py:18:o1-mini",
        "src/defaults.py:23:text-davinci-003",
        "src/defaults.py:24:gpt-4-0613",
        "src/defaults.py:25:gpt-4",
        "src/defaults.py:25:o1",
        "src/defaults.py:26:gpt-3.5-turbo-0125",
        "src/defaults.py:31:gpt-3.5-turbo",
        "src/env.py:3:gpt-4-1106-preview",
        "src/env.py:4:gpt-4-turbo",
        "src/env.py:5:o1-mini",
        "src/env.ts:1:gpt-3.5-turbo",
        "src/env.ts:2:gpt-4",
        "src/framework.py:3:gpt-3.5-turbo",
        "src/framework.py:4:gpt-4",
        "src/framework.py:5:gpt-4",
        "src/request.js:2:tts-1-hd",
        "src/request.py:5:tts-1",
      ].sort(),
    );
    expect(exitCodeForCheck(hits)).toBe(1);
    const text = render(hits, coverage, values);
    expect(text).toContain("Possibly affected: retired or retiring model names set as model values, not confirmed as call sites.");
    expect(text).toContain("  src/defaults.py:4:23    DEFAULT_JUDGE_MODEL = 'gpt-4-turbo'\n");
    expect(text).toContain("  22 values in 6 files\n");
    expect(toJson(values)[0]).toMatchObject({ id: "openai:2026-04-22:legacy-gpt-model-snapshots-shut-down", file: "examples/agent.ts", line: 3, model: "gpt-3.5-turbo" });
  });

  it("knows test files by folder and by name", () => {
    const test = ["tests/a.py", "src/__tests__/a.ts", "test_app.py", "app/x_test.py", "src/app.test.ts", "src/app.spec.js", "conftest.py", "fixtures/a.js", "src/mocks/a.ts"];
    expect(test.filter((f) => !isTestPath(f))).toEqual([]);
    expect(["src/latest.py", "contest.py", "testing.ts", "src/attest/a.py"].filter(isTestPath)).toEqual([]);
  });

  it("takes about as long with tokenizer calls in the file as without", async () => {
    const grammar = grammarFor("app.py")!.grammar;
    // Both files hold the same calls and both get the tokenizer pass, so a healthy run is about 1x. CPU
    // time on shared runners still varies by up to half, so the bound is loose: checking every tokenizer
    // for each value is about 5x here. The search itself is counted step by step in the next test.
    const time = (call: string, runs?: number, budget?: number) => {
      const source = `count_tokens(x)\n${`${call}(x)\nmodel = "gpt-4"\n`.repeat(120_000)}`;
      return cpuTime(() => expect(findModelValues("app.py", source, grammar, new Set(["gpt-4"]))).toHaveLength(120_000), runs, budget);
    };
    const bound = 2.5 * (await time("count_things"));
    // A second run only when the first lands over the bound, as each run takes seconds.
    expect(await time("count_tokens", 2, bound)).toBeLessThan(bound);
  }, 60_000);

  it("finds the range around a value in a few steps however many ranges there are", () => {
    const ranges = Array.from({ length: 2000 }, (_, i) => ({ start: 10 * i, end: 10 * i + 5 }));
    let reads = 0;
    const counted = new Proxy(ranges, {
      get(target, key) {
        if (/^\d+$/.test(String(key))) reads++;
        return Reflect.get(target, key) as unknown;
      },
    });
    expect(ranges.filter((_, i) => inside(counted, 10 * i + 1, 10 * i + 2) && !inside(counted, 10 * i + 4, 10 * i + 6))).toHaveLength(2000);
    // A binary search reads at most 12 ranges per lookup here, a scan from the start about 1000.
    expect(reads).toBeLessThan(2 * 2000 * 50);
  });

  it("reads long call chains in linear time", async () => {
    for (const [file, link] of ["app.py", "app.ts"].flatMap((f) => [".a()", ".token", ".token()"].map((l) => [f, l] as const))) {
      expect(await growth(file, (n) => `model = "gpt-4"; x${link.repeat(40_000 * n)}\n`)).toBeLessThan(24);
    }
  }, 60_000);

  it("reads calls with many arguments about as fast as parsing them", async () => {
    const cases = [
      ["app.ts", '"gpt-4", '],
      ["app.py", '"gpt-4", '],
      ["app.py", 'default="gpt-4", '],
      ["app.ts", '{ default: "gpt-4" }, '],
    ] as const;
    for (const [file, arg] of cases) {
      const grammar = grammarFor(file)!.grammar;
      const source = `f("model", ${arg.repeat(2000)})\n`;
      const parsing = await cpuTime(() => parse(grammar, source), 3);
      expect(await cpuTime(() => findModelValues(file, source, grammar, new Set(["gpt-4"])), 3)).toBeLessThan(10 * parsing + 500);
    }
  }, 60_000);

  it("reads long names, long lines and deep code in linear time", async () => {
    const defaults = (n: number) => 'default="gpt-4", '.repeat(5000 * n);
    const cases = [
      ["app.py", (n: number) => `${"a.".repeat(50_000 * n)}model = f(${defaults(n)})\n`],
      ["app.py", (n: number) => `f("${"model ".repeat(40_000 * n)}", ${defaults(n)}${defaults(n)})\n`],
      ["app.ts", (n: number) => `${" ".repeat(1_000_000 * n)}${'model = "gpt-4"; '.repeat(5000 * n)}\n`],
      ["app.py", (n: number) => `model = ${'f("gpt-4", '.repeat(5000 * n)}x${")".repeat(5000 * n)}\n`],
      ["app.ts", (n: number) => `model = ${'c ? "gpt-4" : ('.repeat(5000 * n)}x${")".repeat(5000 * n)}\n`],
      ["app.ts", (n: number) => `model = x${'.f("gpt-4")'.repeat(20_000 * n)}\n`],
    ] as const;
    const slow = [];
    for (const [file, source] of cases) if ((await growth(file, source)) > 24) slow.push(source(1).slice(0, 20));
    expect(slow).toEqual([]);
  }, 60_000);

  it("does not list a call's model fallback again when it wraps to the next line", async () => {
    const dir = await scratch({
      "app.ts": 'import OpenAI from "openai";\nconst openai = new OpenAI();\nawait openai.chat.completions.create({\n  model:\n    process.env.X ?? "gpt-4",\n  messages: [],\n});\n',
      "app.py": 'import os\nfrom openai import OpenAI\n\nclient = OpenAI()\nclient.chat.completions.create(\n    model=os.environ.get("M")\n    or "gpt-4",\n    messages=[],\n)\n',
    });
    const { hits, values } = await checkReport(dir);
    expect(locations(hits).sort()).toEqual(["app.py:6", "app.ts:4"]);
    expect(values).toEqual([]);
  });

  it("lists a model value on a line another change already reported", async () => {
    const dir = await scratch({ "app.py": 'from openai import OpenAI\n\nclient = OpenAI()\nMODEL = "gpt-4"; client.chat.completions.create(model=MODEL, messages=[], max_tokens=5)\n' });
    const { hits, values } = await checkReport(dir);
    expect(hits.map((h) => h.record.id)).not.toContain(values[0]?.record.id);
    expect(values.map((v) => `${v.line}:${v.model}`)).toEqual(["4:gpt-4"]);
  });

  it("lists a value and a mention under every change that names the model", async () => {
    const record = (await loadRecords()).map((l) => l.record).find((r) => r.id === "openai:2026-04-22:legacy-gpt-model-snapshots-shut-down")!;
    const again = { ...record, id: `${record.id}-again` };
    const dir = await scratch({
      "app.py": 'from openai import OpenAI\n\nclient = OpenAI()\nclient.chat.completions.create(model="gpt-3.5-turbo", messages=[])\nMODEL = "gpt-3.5-turbo"\n',
      "README.md": "Uses gpt-3.5-turbo.\n",
    });
    const { hits, values, mentions } = await scan(dir, ["app.py", "README.md"], [record, again], { modelValues: true, mentions: true });
    const ids = (list: { file: string; line: number; record: { id: string } }[]) => list.map((h) => `${h.file}:${h.line} ${h.record.id}`);
    expect(ids(hits)).toEqual([`app.py:4 ${record.id}`, `app.py:4 ${again.id}`]);
    expect(ids(values)).toEqual([`app.py:5 ${record.id}`, `app.py:5 ${again.id}`]);
    expect(ids(mentions)).toEqual([`README.md:1 ${record.id}`, `README.md:1 ${again.id}`]);
    expect(render(hits, undefined, values, mentions)).toContain("  1 mention in 1 file.");
    // A call site already failing for one record naming the model is not listed again for another.
    const elsewhere = { ...record, id: `${record.id}-elsewhere`, surface: { ...record.surface, sdkSymbols: ["embeddings.create"] } };
    for (const order of [[record, elsewhere], [elsewhere, record]]) {
      const other = await scan(dir, ["app.py", "README.md"], order, { modelValues: true, mentions: true });
      expect(ids(other.hits)).toEqual([`app.py:4 ${record.id}`]);
      expect(ids(other.values).sort()).toEqual([`app.py:5 ${record.id}`, `app.py:5 ${elsewhere.id}`]);
      expect(ids(other.mentions).filter((m) => m.startsWith("app.py"))).toEqual([]);
    }
  });

  it("prints a long list of values quickly", async () => {
    const { values } = await checkReport(await scratch({ "app.py": 'MODEL = "gpt-4"\n' }));
    const many = Array.from({ length: 200_000 }, (_, i) => ({ ...values[0]!, line: i + 1 }));
    // A tenth of a second on a laptop; comparing each value with every other takes 40 seconds.
    expect(await cpuTime(() => expect(render([], undefined, many)).toContain("  200000 values in 1 file\n"))).toBeLessThan(10_000);
  });

  it("does not fail the check when values are all it finds", async () => {
    const { hits, values, coverage } = await checkReport(await scratch({ "app.py": 'MODEL = "gpt-4"\n' }));
    expect(exitCodeForCheck(hits)).toBe(0);
    expect(values.map((v) => v.model)).toEqual(["gpt-4"]);
    expect(render(hits, coverage, values)).toMatch(/^No call sites of known vendor changes found\.\n\nPossibly affected:/);
  });
});

describe("other mentions of model names", () => {
  const MENTIONS = join(SAMPLES, "model-mentions");
  const listed = (ms: { line: number; model: string; file?: string }[]) => ms.map((m) => `${m.file ?? ""}:${m.line}:${m.model}`);

  it("counts every other exact mention in any file, once per name and line", async () => {
    const { hits, values, mentions, coverage } = await checkReport(MENTIONS);
    expect(locations(hits)).toEqual(["src/chat.ts:6"]);
    expect(listed(values)).toEqual(["src/chat.ts:4:o4-mini"]);
    expect(listed(mentions)).toEqual([
      ".env:1:gpt-3.5-turbo",
      "README.md:3:gpt-4",
      "README.md:4:gpt-4-turbo",
      "config.yaml:2:o3-mini",
      "config.yaml:3:o1-mini",
      "src/chat.ts:5:text-davinci-003",
      "src/chat.ts:6:o1",
      "tests/test_chat.py:2:gpt-4",
    ]);
    expect(exitCodeForCheck(hits)).toBe(1);
    const text = render(hits, coverage, values, mentions);
    expect(text).toContain("Also mentioned: retired or retiring model names elsewhere");
    expect(text).toContain("  config.yaml         2  o3-mini, o1-mini\n");
    expect(text).toContain("  8 mentions in 5 files. darnit check --mentions lists each line.\n");
    expect(text).toContain("Scanned 2 JavaScript, TypeScript or Python files against");
    expect(text).toContain("Also searched 3 other files for retired or retiring model names.\n");
    expect(coverage.otherFiles).toBe(3);
    expect(render(hits, coverage, values, mentions, true)).toContain("  src/chat.ts:6  o1\n");
    expect(mentionsToJson(mentions)[0]).toEqual({ id: "openai:2026-04-22:legacy-gpt-model-snapshots-shut-down", file: ".env", line: 1, model: "gpt-3.5-turbo" });
  });

  it("writes the JSON report in pieces, so millions of hits or mentions still fit", async () => {
    const { hits, values, mentions } = await checkReport(join(SAMPLES, "model-mentions"));
    const head = { version: "1", scanned: { files: 1 } };
    const many = <T>(list: T[]) => Array.from({ length: 10_000 }, () => list).flat();
    for (const [h, v, m] of [[[], [], []], [hits, values, mentions.slice(0, 1)], [many(hits), many(values), many(mentions)]] as const) {
      const chunks = [...checkJson(head, { hits: h, possiblyAffected: v, mentions: m })];
      expect(chunks.join("")).toBe(JSON.stringify({ ...head, hits: toJson(h), possiblyAffected: toJson(v), mentions: mentionsToJson(m) }, null, 2));
      expect(Math.max(...chunks.map((c) => c.length))).toBeLessThan(1_000_000);
    }
  });

  it("matches whole names only", () => {
    const names = new Set(["gpt-4", "gpt-4-turbo", "o1"]);
    const text = "gpt-4o gpt-4.1 gpt-4.5 my_gpt-4 a.gpt-4 gpt-4_x xgpt-4 -gpt-4 o1-pro po1\n(gpt-4) gpt-4-turbo, o1\n'gpt-4'.\nmodels/gpt-4..\n";
    expect(listed(findMentions(text, names))).toEqual([":2:gpt-4", ":2:gpt-4-turbo", ":2:o1", ":3:gpt-4", ":4:gpt-4"]);
  });

  it("treats letters and digits in any script as part of a word", () => {
    const names = new Set(["ada", "o1"]);
    const text = '"orçada" "adaé" naïve-o1 Ão1 o1ção "ada²" ٣o1\nA despesa foi orçada. Usamos "ada". «o1»\n';
    expect(listed(findMentions(text, names))).toEqual([":2:ada", ":2:o1"]);
  });

  it("counts a name made only of letters only when it sits directly inside quotes", () => {
    const names = new Set(["ada", "davinci", "gpt-4"]);
    const text = 'ada --name ada ~/ada (ada) "ada \'ada" "ada\'\n"ada" \'davinci\' `ada`\ngpt-4 run\n';
    expect(listed(findMentions(text, names))).toEqual([":2:ada", ":2:davinci", ":3:gpt-4"]);
  });

  it("counts a letter-only name in escaped quotes, as in a notebook cell", () => {
    const text = '    "response = openai.Completion.create(model=\\"davinci\\")\\n",\n"a \\"ada\\\' b \\"ada"\n';
    expect(listed(findMentions(text, new Set(["ada", "davinci"])))).toEqual([":1:davinci"]);
  });

  it("counts a letter-only name set as the whole value of a model or engine setting", () => {
    const text = [
      "OPENAI_MODEL=davinci",
      "  model: curie  ",
      'engine = "ada"',
      "name: ada",
      "--name ada",
      "cd ~/ada",
      "model: ada # old",
      "model: ada.",
      "model:\nada",
      "llm.engine:\tbabbage\r",
      "model ada",
      "",
    ].join("\n");
    expect(listed(findMentions(text, new Set(["ada", "babbage", "curie", "davinci"])))).toEqual([":1:davinci", ":2:curie", ":3:ada", ":11:babbage"]);
  });

  it("lists quoted letter-only names, and big text files but not big binary files under Not checked", async () => {
    const dir = await scratch({
      "README.md": "Start an agent named ada: `--name ada`, then open ~/ada.\nRuns on gpt-4.\n",
      "config.json": '{ "model": "ada" }\n',
      "big.json": "x".repeat(MAX_FILE_BYTES + 100_000),
      "demo.mp4": "\0" + "x".repeat(MAX_FILE_BYTES + 100_000),
    });
    const { hits, mentions, coverage } = await checkReport(dir);
    expect(listed(mentions)).toEqual(["README.md:2:gpt-4", "config.json:1:ada"]);
    expect(coverage.tooLarge).toEqual(["big.json"]);
    expect(render(hits, coverage, [], mentions)).toContain("\nNot checked: 1 file over 10 MB: big.json.\n");
  });

  it("does not count a name like o1 used as a variable in code", () => {
    const names = new Set(["o1", "o3"]);
    const java = "public int compare(String o1, String o2) {\n  if (o1 == null) return o3;\n  s1 = o1;\n}\n";
    expect(findMentions(java, names, "Sort.java")).toEqual([]);
    expect(findMentions("var o1=hb;p=o1(u,{schema:l1});export{o1 as default};\n", names, "assets/index.js")).toEqual([]);
    expect(findMentions("class A { #o1 = 1; }\n#if o1\n", names, "a.ts")).toEqual([]);
    expect(findMentions("#if o1\n#define o3 1\n", names, "a.c")).toEqual([]);
    expect(findMentions("x = a // o1\ndef o1(o3):\n    return o3\n", names, "a.py")).toEqual([]);
  });

  it("counts a name like o1 in code where it names the model: strings, comments, docstrings and settings", () => {
    const names = new Set(["o1"]);
    const ts = [
      'export const o1 = modelRef({ name: "openai/o1" });',
      "// o1 needs max_completion_tokens",
      "/**",
      " * Reasoning models such as o1",
      " */",
      "const note = `uses",
      "o1 by default`;",
      "const s = 'o1';",
      'const t = "a \\" o1";',
      "",
    ].join("\n");
    expect(listed(findMentions(ts, names, "src/gpt.ts"))).toEqual([":1:o1", ":2:o1", ":4:o1", ":7:o1", ":8:o1", ":9:o1"]);
    const py = ['"""Models:', "", "o1 is slow.", '"""', "model = o1", "x = 1  # o1 here", "y = f'''", "o1'''", 'z = r"o1"', ""].join("\n");
    expect(listed(findMentions(py, names, "app.py"))).toEqual([":3:o1", ":5:o1", ":6:o1", ":8:o1", ":9:o1"]);
    expect(listed(findMentions('val s = """\no1\n"""\n', names, "A.kt"))).toEqual([":2:o1"]);
    expect(listed(findMentions("s := `\no1`\n", names, "a.go"))).toEqual([":2:o1"]);
  });

  it("reads raw strings without escapes, Rust lifetimes as code, and ends an unclosed quote at the line end", () => {
    const names = new Set(["o1"]);
    expect(listed(findMentions("parts := strings.Split(p, `\\`)\nmodel := `o1 is retired`\n", names, "a.go"))).toEqual([":2:o1"]);
    expect(listed(findMentions('val p = """C:\\"""\nval q = """o1"""\n', names, "A.kt"))).toEqual([":2:o1"]);
    expect(listed(findMentions('fn f<\'a>(s: &\'a str) {}\nconst S: &\'static str = "don\'t use o1";\n', names, "lib.rs"))).toEqual([":2:o1"]);
    expect(listed(findMentions('let c: &\'static str = x;\nlet o1 = 1;\nlet s = "o1";\n', names, "lib.rs"))).toEqual([":3:o1"]);
    expect(listed(findMentions("const c = 'x;\nlet o1 = 1;\nlet s = \"o1\";\n", names, "a.ts"))).toEqual([":3:o1"]);
  });

  it("counts every mention of a name like o1 in docs, data and files that mix markup into code", () => {
    const names = new Set(["o1"]);
    expect(listed(findMentions("We moved from o1 to o3.\n", names, "README.md"))).toEqual([":1:o1"]);
    expect(listed(findMentions("models:\n  - o1\n", names, "config.yaml"))).toEqual([":2:o1"]);
    expect(listed(findMentions("const o1 = 1;\nreturn <p>Uses o1</p>;\n", names, "App.tsx"))).toEqual([":1:o1", ":2:o1"]);
    expect(listed(findMentions("o1 = 1\n", names))).toEqual([":1:o1"]);
  });

  it("counts a name like o1 on a line over 5,000 characters only directly in quotes or as a setting", () => {
    const names = new Set(["o1", "gpt-4"]);
    const pad = "x".repeat(5000);
    const text = `${pad} o1 +o1/ "a o1"\n${pad} "o1"\n${pad} model: o1\n${pad} gpt-4\n${"y".repeat(4990)} o1\n`;
    for (const file of ["data.jsonl", "report.html"]) expect(listed(findMentions(text, names, file))).toEqual([":2:o1", ":3:o1", ":4:gpt-4", ":5:o1"]);
    expect(listed(findMentions(text, names, "a.js"))).toEqual([":2:o1", ":3:o1", ":4:gpt-4"]);
  });

  it("keeps a separate accent mark inside the word", () => {
    const text = "orc\u0327ada ada\u0301 \u0915\u093fo1\n";
    expect(findMentions(text, new Set(["ada", "o1"]))).toEqual([]);
  });

  it("skips binary files and pruned folders, lists files over the size limit, and never fails the check", async () => {
    const dir = await scratch({
      "notes.txt": "gpt-4\n",
      "logo.png": "\0PNG gpt-4\n",
      "node_modules/x/README.md": "gpt-4\n",
      "big.json": "x".repeat(MAX_FILE_BYTES) + "gpt-4\n",
    });
    const { hits, mentions, coverage } = await checkReport(dir);
    expect(listed(mentions)).toEqual(["notes.txt:1:gpt-4"]);
    expect(coverage.tooLarge).toEqual(["big.json"]);
    expect(exitCodeForCheck(hits)).toBe(0);
    expect(render(hits, coverage, [], mentions)).toMatch(/^No call sites of known vendor changes found\.\n\nAlso mentioned:/);
  });

  it("lists the 20 files with the most mentions", async () => {
    const files = Object.fromEntries(Array.from({ length: 23 }, (_, i) => [`f${i}.md`, "gpt-4\n".repeat(i + 1)]));
    const { mentions } = await checkReport(await scratch(files));
    const text = render([], undefined, [], mentions);
    expect(text).toContain("  f22.md  23  gpt-4\n");
    expect(text).not.toContain("f2.md");
    expect(text).toContain("  and 3 more files\n  276 mentions in 23 files.");
  });

  it("reads a padded file in linear time", async () => {
    const names = new Set(["gpt-4", "o1", "ada"]);
    for (const unit of ["a", ".", "gpt-4.gpt-4x", "x y ", "o1\n", "model= ada ", '\\"ada\\"x ', "engine: \t"]) {
      const text = unit.repeat(Math.ceil(2_000_000 / unit.length));
      expect(await cpuTime(() => findMentions(text, names), 3)).toBeLessThan(3000);
    }
  });
});

describe("findMatches", () => {
  const pattern = [{ context: '({ model: "gpt-4" })', selector: "pair" }];
  const ts = grammarFor("a.ts")!.grammar;

  it("matches quoted text in either quote style, and skips files that do not contain it", () => {
    expect(findMatches("f({ model: 'gpt-4' });\nf({ model: \"gpt-4\" });\n", ts, pattern).map((m) => m.line)).toEqual([2]);
    expect(findMatches('f({ model: "gpt-4o" });\nf({ model: "gpt-3.5-turbo" });\n', ts, pattern)).toEqual([]);
    expect(findMatches("f({ max_tokens: 5 });\n", ts, [{ context: "({ max_tokens: $N })", selector: "pair" }])).toHaveLength(1);
  });

  it("matches a bare key written in quotes, and a keyword argument written as a dict key", () => {
    const js = 'f({ max_tokens: 5 });\nf({ "max_tokens": 5 });\nf({ \'max_tokens\': 5 });\nf({ "max_tokens_x": 5 });\nf("max_tokens", 5);\nf({ "model": o.model ?? "gpt-4" });\n';
    expect(findMatches(js, ts, [{ context: "({ max_tokens: $N })", selector: "pair" }]).map((m) => m.line)).toEqual([1, 2, 3]);
    expect(findMatches(js, ts, pattern).map((m) => m.line)).toEqual([6]);
    const py = grammarFor("a.py")!.grammar;
    const source = 'f(max_tokens=5)\nf(json={"max_tokens": 5})\nf(json={\'max_tokens\': 5})\nf(json={"max_tokens_x": 5})\nf("max_tokens", 5)\nf(json={"model": o or "gpt-4"})\n';
    expect(findMatches(source, py, [{ context: "f(max_tokens=$N)", selector: "keyword_argument" }]).map((m) => m.line)).toEqual([1, 2, 3]);
    expect(findMatches(source, py, [{ context: 'f(model="gpt-4")', selector: "keyword_argument" }]).map((m) => m.line)).toEqual([6]);
  });

  it("counts a node once when a record also lists its quoted form", () => {
    const patterns = [
      { context: "({ spend_control: $V })", selector: "pair" },
      { context: '({ "spend_control": $V })', selector: "pair" },
    ];
    expect(findMatches('f({ "spend_control": 1 });\n', ts, patterns)).toHaveLength(1);
  });

  it("never skips a pattern whose quoted text is a placeholder", () => {
    expect(findMatches('f({ model: "gpt-4" });\n', ts, [{ context: '({ model: "$M" })', selector: "pair" }])).toHaveLength(1);
    const py = grammarFor("a.py")!.grammar;
    expect(findMatches('f(model="gpt-4")\n', py, [{ context: 'f(model="$M")', selector: "keyword_argument" }])).toHaveLength(1);
  });
});

describe("compilePatterns", () => {
  // Records load more than once per process (fix loads them, then check loads them again); each set compiles once.
  it("compiles the same patterns once per process, and a bad set every time", () => {
    const patterns = [{ context: '({ model: "compiled-once" })', selector: "pair" }];
    vi.mocked(parse).mockClear();
    compilePatterns("js", patterns);
    expect(vi.mocked(parse).mock.calls.length).toBeGreaterThan(0);
    vi.mocked(parse).mockClear();
    compilePatterns("js", [{ ...patterns[0]! }]);
    expect(vi.mocked(parse)).not.toHaveBeenCalled();
    compilePatterns("py", [{ context: 'f(model="compiled-once")', selector: "keyword_argument" }]);
    expect(vi.mocked(parse)).toHaveBeenCalled();

    const bad = [{ context: "f(model=", selector: "keyword_argument" }];
    expect(() => compilePatterns("py", bad)).toThrow(/does not compile/);
    expect(() => compilePatterns("py", bad)).toThrow(/does not compile/);
  });

  it("does not take a set that compiled for one language as compiled for another", () => {
    const patterns = [{ context: "f(x)", selector: "call_expression" }];
    compilePatterns("js", patterns);
    expect(() => compilePatterns("py", patterns)).toThrow(/does not compile/);
  });
});

describe("check parses each file once", () => {
  // Every parse and every node read from it holds memory until the file is done: one per record took gigabytes on a file of 20,000 calls.
  it("shares one syntax tree among every record and the model values", async () => {
    const text = 'import OpenAI from "openai";\nconst client = new OpenAI();\nclient.chat.completions.create({ model: "gpt-3.5-turbo-0613", max_tokens: 5 });\nconst model = "gpt-3.5-turbo-0613";\n';
    vi.mocked(parse).mockClear();
    const { hits, values } = await checkReport(await scratch({ "app.ts": text }));
    expect(new Set(hits.map((h) => h.record.id)).size).toBe(2);
    expect(values).toHaveLength(1);
    expect(vi.mocked(parse).mock.calls.filter(([, source]) => source === text)).toHaveLength(1);
  });

  it("reads only the nodes around matches, not every node in the file", async () => {
    const filler = Array.from({ length: 1000 }, (_, i) => `  const total${i} = price * 2 + tax;\n`).join("");
    const text = `import OpenAI from "openai";\nconst client = new OpenAI();\nfunction totals(price, tax) {\n${filler}}\nclient.chat.completions.create({ model: "gpt-3.5-turbo-0613", max_tokens: 5 });\n`;
    const node = SgNode.prototype as unknown as { children(): unknown[]; namedChildren(): unknown[] };
    const spies = [vi.spyOn(node, "children"), vi.spyOn(node, "namedChildren")];
    const { hits } = await checkReport(await scratch({ "app.ts": text }));
    const read = spies.flatMap((s) => s.mock.results).reduce((n, r) => n + (r.value as unknown[]).length, 0);
    for (const spy of spies) spy.mockRestore();
    expect(hits).toHaveLength(2);
    expect(read).toBeLessThan(1000);
  });
});

describe("check on a repository built to slow it down", () => {
  const maxTokens = (hits: Hit[]) => locations(hits.filter((h) => h.record.id.includes("max-tokens")));
  const py = (client: string) => `${client}\nclient.chat.completions.create(model="x", max_tokens=5)\n`;

  it.each([
    ["an import split over thousands of blank lines", "app.py", py(`from openai import (${"\n".repeat(3000)}OpenAI)\nclient = OpenAI()`), 3003],
    ["an import padded with thousands of spaces", "app.js", `import {${" ".repeat(3000)}OpenAI } from "openai";\nconst client = new OpenAI();\nclient.chat.completions.create({ max_tokens: 5 });\n`, 3],
    ["a function with thousands of blank lines", "app.py", py(`from groq import Groq\ndef setup():\n    client = Groq()${"\n".repeat(150_000)}    return client`), 150_004],
  ])("finishes quickly on %s", async (_, name, text, line) => {
    const dir = await scratch({ [name]: text });
    let hits: Hit[] = [];
    expect(await cpuTime(async () => (hits = await check(dir)), 3, 2000)).toBeLessThan(2000);
    expect(maxTokens(hits)).toEqual([`${name}:${line}`]);
  });

  const times = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i)).join("");
  const call = 'client.chat.completions.create(model="x", max_tokens=5)\n';

  // Each takes 8 seconds or more when tracing reads every assignment for every call.
  it.each([
    ["thousands of clients, each with its own call", "app.js", `import OpenAI from "openai";\n${times(3000, (i) => `const c${i} = new OpenAI({ organization: "${"x".repeat(200)}" });\nc${i}.chat.completions.create({ max_tokens: 5 });\n`)}`, 3000, 3000],
    ["a thousand calls on a client set a thousand times", "app.py", `from openai import OpenAI\n${times(1000, () => "client = OpenAI()\n")}${times(1000, () => call)}`, 1000, 2000],
    ["a thousand calls and a thousand functions setting the client", "app.py", `from openai import OpenAI\n${times(1000, (i) => `def f${i}():\n    client = OpenAI()\n`)}${times(1000, () => call)}`, 1000, 2000],
    ["an assignment chained thousands of names long", "app.py", py(`from openai import OpenAI\n${times(4000, (i) => `a${i} = `)}1\nclient = OpenAI()`), 1, 2000],
    ["calls on clients whose address is set in 50 nested blocks", "app.js", `import OpenAI from "openai";\n${times(50, (i) => `{\nconst baseURL = "http://localhost:${i}";\nvar client = new OpenAI({ baseURL });\n`)}${times(20, () => "client.chat.completions.create({ max_tokens: 5 });\n")}${"}\n".repeat(50)}`, 20, 2000],
  ])("finishes quickly on %s", { timeout: 300_000 }, async (_, name, text, count, budget) => {
    const dir = await scratch({ [name]: text });
    let hits: Hit[] = [];
    expect(await cpuTime(async () => (hits = await check(dir)), 3, budget)).toBeLessThan(budget);
    expect(maxTokens(hits)).toHaveLength(count);
  });

  it("checks thousands of realtime class calls, and as many on a look-alike class, within a CPU budget", { timeout: 60_000 }, async () => {
    const create = (cls: string, client: string) => `${cls}.create(${client}, { model: "gpt-4o-realtime-preview-2024-10-01" });\n`;
    const text = [
      'import OpenAI from "openai";\nimport { OpenAIRealtimeWS } from "openai/realtime/ws";\nimport { OpenAIRealtimeWebSocket } from "other";\n',
      times(3000, (i) => `const c${i} = new OpenAI();\n${create("OpenAIRealtimeWS", `c${i}`)}${create("OpenAIRealtimeWebSocket", `c${i}`)}`),
    ].join("");
    const dir = await scratch({ "app.ts": text });
    let hits: Hit[] = [];
    // About 0.9 seconds on a laptop.
    expect(await cpuTime(async () => ({ hits } = await checkReport(dir)), 3, 5000)).toBeLessThan(5000);
    expect(new Set(hits.map((h) => h.line)).size).toBe(3000);
  });

  it("checks a class name imported from thousands of packages, with as many calls, within a CPU budget", { timeout: 60_000 }, async () => {
    const text = [
      times(16000, (i) => `import { OpenAIRealtimeWS } from "pkg${i}/realtime/ws";\n`),
      times(16000, () => 'OpenAIRealtimeWS.create(c, { model: "gpt-4o-realtime-preview-2024-10-01" });\n'),
    ].join("");
    const dir = await scratch({ "app.ts": text });
    let hits: Hit[] = [];
    // About 2 seconds on a laptop; 16 when each call walked every import of the name.
    expect(await cpuTime(async () => ({ hits } = await checkReport(dir)), 3, 8000)).toBeLessThan(8000);
    expect(hits).toEqual([]);
  });

  it("traces each call through the assignments it can see, not every one of the name in the file", async () => {
    const text = `from groq import Groq\n${times(51, (i) => `def test_${i}():\n    client = Groq()\n    ${call}`)}`;
    const { hits, coverage } = await checkReport(await scratch({ "app.py": text }));
    expect(maxTokens(hits)).toEqual([]);
    expect(coverage.foreign).toBe(51);
  });

  it("does not trace a name set more than 50 times where one call sees it, so the call counts as the vendor's", async () => {
    const text = (n: number) => `from groq import Groq\n${times(n, () => "client = Groq()\n")}${call}`;
    expect(maxTokens(await check(await scratch({ "app.py": text(50) })))).toEqual([]);
    expect(maxTokens(await check(await scratch({ "app.py": text(51) })))).toEqual(["app.py:53"]);
  });

  // Each took over a minute when every call looked up its surroundings again.
  it.each([
    ["SDK calls nested 2000 deep", "app.py", `from openai import OpenAI\nclient = OpenAI()\nx = ${"client.chat.completions.create(max_tokens=5, x=".repeat(2000)}1${")".repeat(2000)}\n`, 2000],
    ["calls in functions nested 2000 deep", "app.js", `import OpenAI from "openai";\nconst client = new OpenAI();\n${times(2000, (i) => `function f${i}(a) {\n  client.chat.completions.create({ max_tokens: 5 });\n`)}${"}\n".repeat(2000)}`, 2000],
  ])("finishes quickly on %s", { timeout: 300_000 }, async (_, name, text, count) => {
    const dir = await scratch({ [name]: text });
    let hits: Hit[] = [];
    expect(await cpuTime(async () => (hits = await check(dir)), 3, 5000)).toBeLessThan(5000);
    expect(maxTokens(hits)).toHaveLength(count);
  });

  const request = (args: string) => `requests.post("https://api.openai.com/v1/chat/completions", ${args})`;

  it.each([
    ["a request with thousands of keyword arguments", `import requests\n${request("max_tokens=5, ".repeat(2000))}\n`, 2000],
    ["a request body with thousands of quoted keys", `import requests\n${request(`json={${'"max_tokens": 5, '.repeat(2000)}}`)}\n`, 2000],
    ["a request inside calls nested 1500 deep", `import requests\nx = ${"f(max_tokens=5, ".repeat(1500)}${request("max_tokens=5")}${")".repeat(1500)}\n`, 1],
  ])("finishes quickly on %s", async (_, text, count) => {
    const dir = await scratch({ "app.py": text });
    let hits: Hit[] = [];
    expect(await cpuTime(async () => (hits = await check(dir)), 3, 2000)).toBeLessThan(2000);
    expect(maxTokens(hits)).toHaveLength(count);
  });

  it.each([
    ["global client", "app.py", py("from groq import Groq\ndef setup():\n    global client\n    client = Groq()"), "app.py:5"],
    ["global client in a nested block", "app.py", py("from groq import Groq\ndef setup():\n    if True:\n        global client\n    client = Groq()"), "app.py:6"],
  ])("reads a function's %s, so a look-alike client set there stays left out", async (_, name, text, at) => {
    const { hits, coverage } = await checkReport(await scratch({ [name]: text }));
    expect(maxTokens(hits)).toEqual([]);
    expect(coverage.foreignAt).toEqual([at]);
  });

  it.each([
    ["global other", "app.py", py("from groq import Groq\ndef setup():\n    global other\n    client = Groq()"), "app.py:5"],
    [
      "the text global client in a JavaScript function",
      "app.js",
      'import Groq from "groq-sdk";\nfunction setup() {\n  const note = `\nglobal client`;\n  var client = new Groq();\n}\nclient.chat.completions.create({ model: "x", max_tokens: 5 });\n',
      "app.js:7",
    ],
  ])("does not take %s as declaring the client global", async (_, name, text, at) => {
    expect(maxTokens(await check(await scratch({ [name]: text })))).toEqual([at]);
  });

  it.each(["app.js", "app.py", "App.kt"])("finds strings and comments in a crafted 10 MB %s in linear time", { timeout: 60_000 }, async (file) => {
    const names = new Set(["o1", "gpt-4"]);
    for (const unit of ["\"o1 '\\\n", "/*o1\n", "'''o1\\\n", '\\\\"o1"\n', '`o1 #o1 """\n', "o1 o1\n"]) {
      const text = unit.repeat(Math.floor(MAX_FILE_BYTES / unit.length));
      expect(await cpuTime(() => findMentions(text, names, file))).toBeLessThan(3000);
    }
  });

  it("does not read a file over the size limit, and says so", async () => {
    const call = 'import OpenAI from "openai";\nnew OpenAI().chat.completions.create({ max_tokens: 5 });\n';
    const dir = await scratch({ "small.js": call, "big.js": call + " ".repeat(MAX_FILE_BYTES) });
    const { hits, coverage } = await checkReport(dir);
    expect(maxTokens(hits)).toEqual(["small.js:2"]);
    expect(coverage).toMatchObject({ files: 1, tooLarge: ["big.js"] });
    expect(render(hits, coverage)).toContain("\nNot checked: 1 file over 10 MB: big.js.\n");
  });
});

/** Peak memory in MB of a fresh process checking `dir`, and its hits: a process carries its parent's peak in maxRSS, so this reads Linux's own. */
function peakOf(dir: string): { hits: number; peak: number } {
  const script = [
    "const { checkReport } = await import(process.argv[1]);",
    "const { hits } = await checkReport(process.argv[2]);",
    'const { readFileSync } = await import("node:fs");',
    'console.log(JSON.stringify({ hits: hits.length, peak: Number(/VmHWM:\\s+(\\d+)/.exec(readFileSync("/proc/self/status", "utf8"))[1]) / 1024 }));',
  ].join(" ");
  return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, fileURLToPath(new URL("../src/check.ts", import.meta.url)), dir], { encoding: "utf8" })) as { hits: number; peak: number };
}

describe("check on a file built to overflow the stack", () => {
  const maxTokens = (hits: Hit[]) => hits.filter((h) => h.record.id.includes("max-tokens")).map((h) => `${h.file}:${h.line}:${h.column}`);
  const url = (n: number) => `"https://api.openai.com/v1/chat/completions"${' + "x"'.repeat(n)}`;
  const deep = (n: number) => ({
    "app.js": `export const r = fetch(${url(n)}, { method: "POST", body: JSON.stringify({ max_tokens: 5 }) });\n`,
    "app.py": `import requests\n\nr = requests.post(${url(n)}, json=dict(max_tokens=5))\n`,
  });
  const at = (files: Record<string, string>) =>
    Object.entries(files).map(([name, text]) => {
      const lines = text.split("\n");
      const line = lines.findIndex((l) => l.includes("max_tokens"));
      return `${name}:${line + 1}:${lines[line]!.indexOf("max_tokens") + 1}`;
    });

  it.each([3000, 100_000])("finds the call site in a URL built from %i concatenations within a CPU budget", { timeout: 60_000 }, async (n) => {
    const files = deep(n);
    const dir = await scratch(files);
    let hits: Hit[] = [];
    // About 1.2 seconds at 100,000; over 6 when each piece of the URL was read in JavaScript, and a stack overflow at 3,000 when that read recursed.
    expect(await cpuTime(async () => ({ hits } = await checkReport(dir)), 3, 3000)).toBeLessThan(3000);
    expect(maxTokens(hits).sort()).toEqual(at(files));
  });

  it.runIf(process.platform === "linux")("scans a URL built from 100,000 concatenations within a memory budget", { timeout: 60_000 }, async () => {
    // About 160 MB; over 500 when each piece of the URL was read in JavaScript.
    const { hits, peak } = peakOf(await scratch({ "app.js": deep(100_000)["app.js"] }));
    expect(hits).toBe(1);
    expect(peak).toBeLessThan(300);
  });

  const U = '"https://api.openai.com/v1/chat/completions"';
  const helper = 'g("/v1/chat/completions") + ';
  // Each costs about what a flat file of its size does: 0.5 to 1.2 seconds and 120 to 200 MB. Calls nested in a URL took
  // 40 seconds and 5.6 GB at 3,000 when each URL and each call around a match searched every call inside it, and a request
  // nested in each request's URL took 9 seconds and 1.5 GB at 6,000 when each URL was copied whole.
  it.each([
    ["calls nested in a URL", "app.js", `export const r = ${`fetch(${helper}`.repeat(3000)}fetch("b", { body: JSON.stringify({ max_tokens: 5 }) })${")".repeat(3000)};\n`, 0],
    ["calls nested in a Python URL", "app.py", `import requests\nr = ${`requests.post(${helper}`.repeat(3000)}requests.post("b", json=dict(max_tokens=5))${")".repeat(3000)}\n`, 0],
    ["requests nested in a URL with no endpoint", "app.js", `export const r = ${'fetch("a" + '.repeat(10_000)}fetch("b", { body: JSON.stringify({ max_tokens: 5 }) })${")".repeat(10_000)};\n`, 0],
    ["a request nested in each request's URL", "app.js", `export const r = ${`fetch(${U} + `.repeat(6000)}"x"${", { max_tokens: 5 })".repeat(6000)};\n`, 6000],
  ])("checks %s within a CPU and memory budget", { timeout: 120_000 }, async (_, name, text, count) => {
    const dir = await scratch({ [name]: text, "small.js": "export const x = 1;\n" });
    let hits: Hit[] = [];
    expect(await cpuTime(async () => ({ hits } = await checkReport(dir)), 3, 3000)).toBeLessThan(3000);
    expect(maxTokens(hits)).toHaveLength(count);
    if (process.platform === "linux") expect(peakOf(dir).peak).toBeLessThan(400);
  });

  it("reads the address of a URL longer than 2,048 characters from its start", async () => {
    const call = (host: string) => `export const r = fetch("${host}/v1/chat/completions?k=" + "${"x".repeat(2100)}", { body: JSON.stringify({ max_tokens: 5 }) });\n`;
    // The first 2,048 characters, quote included, end inside the host, on a known look-alike's name.
    const cut = `"https://${"a".repeat(2048 - '"https://.api.groq.com'.length)}.api.groq.com`;
    const dir = await scratch({ "groq.js": call("https://api.groq.com/openai"), "local.js": call("http://localhost:11434"), "cut.js": call(`${cut.slice(1)}b`) });
    const { hits, foreign, coverage } = await checkReport(dir);
    expect(locations(foreign)).toEqual(["groq.js:1"]);
    expect(hits.filter((h) => h.record.id.includes("max-tokens")).map((h) => [h.file, h.local])).toEqual([
      ["cut.js", undefined],
      ["local.js", ["localhost:11434"]],
    ]);
    expect(render(hits, coverage)).toContain("(sent to localhost:11434; ignore if that server isn't OpenAI)");
  });
});

describe("check on a file the scanner fails on", () => {
  const call = "import OpenAI from 'openai';\nawait new OpenAI().chat.completions.create({ model: 'm', max_tokens: 5 });\n";
  const failing = async <T>(run: () => Promise<T>): Promise<T> => {
    const real = vi.mocked(parse).getMockImplementation()!;
    vi.mocked(parse).mockImplementation((lang, source) => {
      if (source.includes("FAILS")) throw new Error("crafted");
      return real(lang, source);
    });
    try {
      return await run();
    } finally {
      vi.mocked(parse).mockImplementation(real);
    }
  };

  it("names it under Not checked, keeps every other file's findings, and exits 2", async () => {
    const dir = await scratch({ "a.ts": call, "b.ts": `${call}// FAILS\n`, "c.py": 'from openai import OpenAI\nOpenAI().chat.completions.create(model="m", max_tokens=5)\n' });
    const { hits, coverage, values, mentions } = await failing(() => checkReport(dir));
    expect(locations(hits.filter((h) => h.record.id.includes("max-tokens")))).toEqual(["a.ts:2", "c.py:2"]);
    expect(coverage).toMatchObject({ files: 2, skipped: [{ path: "b.ts", reason: "could not be scanned" }] });
    expect(exitCodeForCheck(hits, coverage)).toBe(2);
    expect(render(hits, coverage)).toContain("\nNot checked: 1 file darnit failed to scan: b.ts.\n");
    const json = JSON.parse([...checkJson({ version: "t", scanned: coverage }, { hits, possiblyAffected: values, mentions })].join("")) as { scanned: Coverage };
    expect(json.scanned.skipped).toEqual([{ path: "b.ts", reason: "could not be scanned" }]);
  });

  it("says the check fails, not that unreviewed changes do not fail it", async () => {
    const dir = await scratch({ "a.ts": call, "b.ts": `${call}// FAILS\n` });
    const { hits, coverage } = await failing(() => checkReport(dir));
    const unreviewed = hits.map((h) => ({ ...h, record: { ...h.record, status: "candidate" as const } }));
    expect(exitCodeForCheck(unreviewed, coverage)).toBe(2);
    const text = render(unreviewed, coverage);
    expect(text).not.toContain("do not fail the check");
    expect(text).toContain("\nThe check fails because darnit failed to scan a file.\n");
    expect(render(unreviewed, { ...coverage, skipped: [] })).toContain("Unreviewed changes are reported but do not fail the check.");
  });

  it("does not call the repository clean when that file is the only one", async () => {
    const { hits, coverage } = await failing(async () => checkReport(await scratch({ "b.ts": `${call}// FAILS\n` })));
    expect(render(hits, coverage).split("\n")[0]).toBe("No call sites of known vendor changes found.");
    expect(exitCodeForCheck(hits, coverage)).toBe(2);
  });

  it("reports none of that file's call sites or values, found before the failure or not, but keeps its mentions", async () => {
    const model = "gpt-3.5-turbo-0613";
    const text = `${call}export const m = { model: "${model}" };\n// FAILS later\n`;
    const node = SgNode.prototype as unknown as { findAll: (this: SgNode, matcher: unknown) => SgNode[] };
    const findAll = node.findAll;
    // Fails reading model values, after the file's call sites were found.
    const spy = vi.spyOn(node, "findAll").mockImplementation(function (this: SgNode, matcher) {
      if (JSON.stringify(matcher).includes('"template_string"') && this.text().includes("FAILS later")) throw new Error("crafted");
      return findAll.call(this, matcher);
    });
    try {
      const { hits, values, mentions, coverage } = await checkReport(await scratch({ "b.ts": text, "a.ts": call }));
      expect(locations(hits)).toEqual(["a.ts:2"]);
      expect(values).toEqual([]);
      expect(mentions.map((m) => `${m.file}:${m.line} ${m.model}`)).toContain(`b.ts:3 ${model}`);
      expect(coverage.skipped).toEqual([{ path: "b.ts", reason: "could not be scanned" }]);
    } finally {
      spy.mockRestore();
    }
  });

  it("makes darnit check exit 2 after printing the report", { timeout: 60_000 }, async () => {
    const dir = await scratch({ "b.ts": `${call}// FAILS\n` });
    const preload = join(await scratch({}), "fails.cjs");
    const napi = createRequire(import.meta.url).resolve("@ast-grep/napi");
    await writeFile(preload, `const napi = require(${JSON.stringify(napi)});\nconst parse = napi.parse;\nnapi.parse = (lang, source) => { if (source.includes("FAILS")) throw new Error("crafted"); return parse(lang, source); };\n`);
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const run = spawnSync(process.execPath, ["--require", preload, "--import", "tsx", cli, "check", dir], { encoding: "utf8", env: { ...process.env, DARNIT_NO_UPDATE_CHECK: "1", GITHUB_ACTIONS: "" } });
    expect(run.status).toBe(2);
    expect(run.stdout).toContain("\nNot checked: 1 file darnit failed to scan: b.ts.\n");
  });
});
