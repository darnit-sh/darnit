import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { check, checkReport, exitCodeForCheck, render, toJson, type Hit } from "../src/check.js";

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
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
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
    expect(render(hits, coverage)).toContain("Left out 5 calls made through another provider's client with the same methods.");
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

  it("still catches look-alikes written in less common ways", async () => {
    const dir = await scratch({
      "multiline.py": "from groq import (\n    Groq,\n)\n\nc = Groq()\nr = c.chat.completions.create(model='m', max_tokens=5)\n",
      "fstring.py": 'from openai import OpenAI\n\nc = OpenAI(base_url=f"https://api.groq.com/openai/v1")\nr = c.chat.completions.create(model="m", max_tokens=5)\n',
      "modules.py": "import os, groq\n\nc = groq.Groq()\nr = c.chat.completions.create(model='m', max_tokens=5)\n",
      "constant.ts":
        'import OpenAI from "openai";\nconst BASE = "https://api.groq.com/openai/v1";\nconst c = new OpenAI({ baseURL: BASE });\nexport const r = c.chat.completions.create({ model: "m", messages: [], max_tokens: 5 });\n',
      "shorthand.ts":
        'import OpenAI from "openai";\nconst baseURL = "https://openrouter.ai/api/v1";\nconst c = new OpenAI({ baseURL });\nexport const r = c.chat.completions.create({ model: "m", messages: [], max_tokens: 5 });\n',
    });
    const { hits, coverage } = await checkReport(dir);
    expect(maxTokens(hits)).toEqual([]);
    expect(coverage.foreign).toBe(5);
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

describe("check", () => {
  it("reports what it covered, counting only files it can parse", async () => {
    const dir = await scratch({ "a.js": "export const x = 1;\n", "b.py": "x = 1\n", "notes.md": "# hi\n" });
    const { hits, coverage } = await checkReport(dir);
    expect(hits).toEqual([]);
    expect(coverage.files).toBe(2);
    expect(coverage.records).toBeGreaterThanOrEqual(2);
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
    expect(locations(hits)).toEqual(["app.js:6", "app.js:7", "app.js:8", "app.js:9", "app.js:10", "app.py:6", "app.py:7", "app.py:8", "app.py:9", "app.py:10"]);
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

    // Only a reviewed change fails the check; a candidate alone never turns a scheduled run red.
    expect(exitCodeForCheck([candidate])).toBe(0);
    expect(exitCodeForCheck([candidate, hits[0]!])).toBe(1);
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
