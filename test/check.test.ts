import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { check, render, toJson, type Hit } from "../src/check.js";

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

describe("check", () => {
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

  it("does not report an options object passed by name", async () => {
    const dir = await scratch({ "detached.js": 'import OpenAI from "openai";\nconst opts = { max_tokens: 5 };\nnew OpenAI().chat.completions.create(opts);\n' });
    expect(await check(dir)).toEqual([]);
    expect(render([])).toBe("No known vendor changes affect this repository.");
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
    const stripeOnly = await scratch({ "app.js": source, "darnit.yml": "version: 1\napis:\n  stripe:\n    tier: detected\n" });
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

    const candidate = { ...hits[0]!, record: { ...hits[0]!.record, status: "candidate" as const } };
    expect(render([candidate])).toContain("(unreviewed change, detection only)");

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
