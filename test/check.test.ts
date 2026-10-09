import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { check, checkReport, exitCodeForCheck, render, snippet, toJson, type Hit } from "../src/check.js";
import { loadRecords } from "../src/records/load.js";
import { findMatches, grammarFor } from "../src/scan/astgrep.js";

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
    const local = Object.fromEntries(hits.map((h) => [`${h.file}:${h.line}`, h.local ?? null]));
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
    expect(render(hits, coverage)).toMatch(/ollama\.ts:3:72 +max_tokens: 5 {2}\(sent to localhost:11434; skip if that server isn't OpenAI\)\n/);
    expect(toJson(hits).find((h) => (h as { file: string }).file === "ollama.ts")).toMatchObject({ localAddress: "localhost:11434" });
    expect(toJson(hits).find((h) => (h as { file: string }).file === "plain.ts")).not.toHaveProperty("localAddress");
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

describe("findMatches", () => {
  const pattern = [{ context: '({ model: "gpt-4" })', selector: "pair" }];
  const ts = grammarFor("a.ts")!.grammar;

  it("matches quoted text in either quote style, and skips files that do not contain it", () => {
    expect(findMatches("f({ model: 'gpt-4' });\nf({ model: \"gpt-4\" });\n", ts, pattern).map((m) => m.line)).toEqual([2]);
    expect(findMatches('f({ model: "gpt-4o" });\nf({ model: "gpt-3.5-turbo" });\n', ts, pattern)).toEqual([]);
    expect(findMatches("f({ max_tokens: 5 });\n", ts, [{ context: "({ max_tokens: $N })", selector: "pair" }])).toHaveLength(1);
  });

  it("never skips a pattern whose quoted text is a placeholder", () => {
    expect(findMatches('f({ model: "gpt-4" });\n', ts, [{ context: '({ model: "$M" })', selector: "pair" }])).toHaveLength(1);
    const py = grammarFor("a.py")!.grammar;
    expect(findMatches('f(model="gpt-4")\n', py, [{ context: 'f(model="$M")', selector: "keyword_argument" }])).toHaveLength(1);
  });
});
