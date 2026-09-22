import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { detectApis } from "../src/detect.js";
import { init } from "../src/init.js";

const SAMPLES = fileURLToPath(new URL("./samples/", import.meta.url));

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function scratchCopy(sample: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "darnit-init-"));
  tempDirs.push(dir);
  await cp(join(SAMPLES, sample), dir, { recursive: true });
  return dir;
}

describe("detectApis", () => {
  it("finds openai in every sample repo, by the right evidence", async () => {
    const small = await detectApis(join(SAMPLES, "small"));
    expect(small).toEqual([{ vendor: "openai", evidence: ["index.js: import openai", "package.json: openai"] }]);

    const medium = await detectApis(join(SAMPLES, "medium"));
    expect(medium.map((d) => d.vendor)).toEqual(["openai", "stripe"]);
    expect(medium[0]?.evidence).toEqual([
      "package.json: openai",
      "requirements.txt: openai",
      "src/chat.ts: import openai",
      "worker.py: import openai",
    ]);

    // messy: no SDK anywhere, only a raw fetch to the API host
    const messy = await detectApis(join(SAMPLES, "messy"));
    expect(messy.find((d) => d.vendor === "openai")?.evidence).toEqual(["lib/client.js: api.openai.com"]);
    expect(messy.find((d) => d.vendor === "stripe")?.evidence).toEqual(["pyproject.toml: stripe"]);
  });

  it("ignores node_modules and other vendored directories, and survives bad manifests", async () => {
    const dir = await scratchCopy("small");
    await mkdir(join(dir, "node_modules", "some-lib"), { recursive: true });
    await writeFile(
      join(dir, "node_modules", "some-lib", "package.json"),
      JSON.stringify({ dependencies: { "@anthropic-ai/sdk": "1.0.0", stripe: "1.0.0" } }),
    );
    await mkdir(join(dir, "templates"));
    await writeFile(join(dir, "templates", "package.json"), '﻿{ "name": "{{name}}", // not json\n');
    expect((await detectApis(dir)).map((d) => d.vendor)).toEqual(["openai"]);
  });

  it("counts a Python package only when a manifest declares it, not when prose mentions it", async () => {
    const dir = await scratchCopy("small");
    await writeFile(join(dir, "Pipfile"), '[packages]\nstripe = "*"\n');
    await writeFile(join(dir, "pyproject.toml"), '[project]\ndescription = "an anthropic wrapper"\n# openai not used\n');
    expect(await detectApis(dir)).toEqual([
      { vendor: "openai", evidence: ["index.js: import openai", "package.json: openai"] },
      { vendor: "stripe", evidence: ["Pipfile: stripe"] },
    ]);
  });
});

describe("init", () => {
  it("writes darnit.yml and the workflow, and is a no-op on the second run", async () => {
    const dir = await scratchCopy("medium");

    const first = await init(dir);
    expect(first[0]).toMatch(/^Scanned repo: found openai \(package\.json: openai\), stripe/);
    expect(first.slice(1)).toEqual(["Wrote darnit.yml", "Wrote .github/workflows/darnit.yml"]);

    const yml = await readFile(join(dir, "darnit.yml"), "utf8");
    expect(yml).toContain("openai:\n    tier: supported");
    expect(yml).toContain("stripe:\n    tier: detected");
    const workflow = await readFile(join(dir, ".github", "workflows", "darnit.yml"), "utf8");
    expect(workflow).toContain("cron:");
    expect(workflow).toContain("npx darnit check");

    const second = await init(dir);
    expect(second.slice(1)).toEqual([
      "darnit.yml exists, left unchanged (--force to rewrite)",
      ".github/workflows/darnit.yml exists, left unchanged (--force to rewrite)",
    ]);
    expect(await readFile(join(dir, "darnit.yml"), "utf8")).toBe(yml);

    const forced = await init(dir, { force: true });
    expect(forced.slice(1)).toEqual(["Rewrote darnit.yml", "Rewrote .github/workflows/darnit.yml"]);
  });
});
