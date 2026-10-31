import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { access, appendFile, chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse as parseCode } from "@ast-grep/napi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { checkReport } from "../src/check.js";
import { applyAndVerify, exitCodeFor, fix, type FixOptions, forTerminal, prBody, prose, Refusal, renderSummary, toJson } from "../src/fix.js";
import { git } from "../src/git.js";
import { WORKFLOW } from "../src/init.js";
import { CAPS, type Plan } from "../src/plan.js";
import { loadRecords, PACKS_DIR } from "../src/records/load.js";
import { runTests } from "../src/tests.js";
import { annotations, cpuTime, matchersAtDarnit, SETUP_NODE_MATCHERS } from "./helpers.js";

vi.mock("@ast-grep/napi", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ast-grep/napi")>();
  return { ...real, parse: vi.fn(real.parse) };
});

// A short limit for the build and test runs, and a count of them, so a hung check costs a test half a second.
const runs = vi.hoisted(() => ({ limitMs: undefined as number | undefined, count: 0 }));
vi.mock("../src/tests.js", async (original) => {
  const real = await original<typeof import("../src/tests.js")>();
  return {
    ...real,
    runTests: (root: string, command: string, limitMs?: number) => {
      runs.count++;
      return real.runTests(root, command, runs.limitMs ?? limitMs);
    },
  };
});

const PACKS = fileURLToPath(new URL("../packs/", import.meta.url));

const tempDirs: string[] = [];
afterEach(async () => {
  runs.limitMs = undefined;
  runs.count = 0;
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repoFrom(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "darnit-fix-"));
  tempDirs.push(dir);
  await cp(source, dir, { recursive: true });
  await git(dir, ["init", "-q"]);
  await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
  await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  return dir;
}

async function planHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "darnit-plan-"));
  tempDirs.push(dir);
  return dir;
}

async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of (await readdir(dir, { recursive: true })).filter((f) => !f.startsWith(".git")).sort()) {
    const text = await readFile(join(dir, f), "utf8").catch(() => undefined);
    if (text !== undefined) out[f] = text;
  }
  return out;
}

// OpenAI over raw HTTP: check finds max_tokens by the endpoint, but the rewrite rules only cover SDK calls.
const RAW_FETCH = `export const ask = (prompt) =>
  fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "x", messages: [{ role: "user", content: prompt }], max_tokens: 100 }),
  });
`;
const SDK_CALL = `import OpenAI from "openai";
export const r = new OpenAI().chat.completions.create({ model: "x", messages: [], max_tokens: 5 });
`;

async function repoWith(files: Record<string, string>): Promise<string> {
  const src = await mkdtemp(join(tmpdir(), "darnit-src-"));
  tempDirs.push(src);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(src, name)), { recursive: true });
    await writeFile(join(src, name), text);
  }
  return repoFrom(src);
}

/** The CLI run outside GitHub Actions, wherever the tests run, unless `env` says otherwise. */
const darnit = (cwd: string, ...args: string[]) => darnitWith({}, cwd, ...args);

async function darnitWith(extra: NodeJS.ProcessEnv, cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const env = { ...process.env, DARNIT_NO_UPDATE_CHECK: "1", GITHUB_ACTIONS: "", GITHUB_TOKEN: "", GH_TOKEN: "", SSH_AUTH_SOCK: "", ...extra };
  return new Promise((resolve) =>
    execFile(process.execPath, ["--import", import.meta.resolve("tsx"), cli, ...args], { cwd, env }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    ),
  );
}

describe("text from the repository in output", () => {
  const HIDDEN = /[\u0080-\u009f\u061C\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
  const call = 'max_tokens: /*\u202E\u2066*/ cap("\u202Eab\u2069\u009b\u200B\uFEFF1A")';
  const plain = 'max_tokens: cap("café 日本 🎉 👨‍👩‍👧 שלום")';
  const source = `import OpenAI from "openai";\nconst c = new OpenAI();\nexport const r = c.chat.completions.create({ ${call} });\nexport const s = c.chat.completions.create({ ${plain} });\n`;

  it("writes out direction-changing and C1 characters in check and check --json, and leaves ordinary Unicode alone", async () => {
    const dir = await repoWith({ "app.ts": source });
    const { stdout } = await darnit(dir, "check");
    expect(stdout).not.toMatch(HIDDEN);
    expect(stdout).toContain(String.raw`app.ts:3:46  max_tokens: /*\u202e\u2066*/ cap("\u202eab\u2069\u009b\u200b\ufeff1A")`);
    expect(stdout).toContain(`app.ts:4:46  ${plain}`);
    const json = await darnit(dir, "check", "--json");
    expect(json.stdout).not.toMatch(HIDDEN);
    expect((JSON.parse(json.stdout) as { hits: { text: string }[] }).hits.map((h) => h.text)).toEqual([call, plain]);
  });

  it("writes them out in fix's diff and fix --json", async () => {
    const dir = await repoWith({ "app.ts": source });
    const { stdout } = await darnit(dir, "fix", "--dry-run", "--no-test");
    expect(stdout).not.toMatch(HIDDEN);
    expect(stdout).toContain(String.raw`-export const r = c.chat.completions.create({ max_tokens: /*\u202e\u2066*/ cap("\u202eab\u2069\u009b\u200b\ufeff1A") });`);
    expect(stdout).toContain(String.raw`+export const r = c.chat.completions.create({ max_completion_tokens: cap("\u202eab\u2069\u009b\u200b\ufeff1A") });`);
    expect(stdout).toContain(`+export const s = c.chat.completions.create({ ${plain.replace("max_tokens", "max_completion_tokens")} });`);
    const json = await darnit(dir, "fix", "--dry-run", "--no-test", "--json");
    expect(json.stdout).not.toMatch(HIDDEN);
    expect((JSON.parse(json.stdout) as { diff: string }).diff).toContain(`-export const r = c.chat.completions.create({ ${call} });`);
  });

  it("keeps only darnit's colors in fix's diff on a terminal", async () => {
    const codes = "\u001b[8mhidden\u001b[0m \u001b[30;40mblack\u001b[38;2;0;0;0m \u001b[2Jwipe";
    const dir = await repoWith({ "app.ts": `import OpenAI from "openai";\n// ${codes}\n${SDK_CALL.split("\n")[1]} // ${codes}\n` });
    const tty = { NODE_OPTIONS: "--import=data:text/javascript,process.stdout.isTTY=true" };
    const { stdout } = await darnitWith(tty, dir, "fix", "--dry-run", "--no-test");
    expect(stdout).toContain("\u001b[36m@@ -1,3 +1,3 @@\u001b[m");
    expect(stdout).toContain(" // [8mhidden[0m [30;40mblack[38;2;0;0;0m [2Jwipe\n");
    expect(stdout).toContain("\u001b[31m-export const r = new OpenAI().chat.completions.create({ model: \"x\", messages: [], max_tokens: 5 }); // [8mhidden");
    expect(stdout).toContain("\u001b[32m+export const r = new OpenAI().chat.completions.create({ model: \"x\", messages: [], max_completion_tokens: 5 }); // [8mhidden");
    // eslint-disable-next-line no-control-regex
    expect(stdout.replace(/\u001b\[(1|31|32|36|41)?m/g, "")).not.toContain("\u001b");
    expect((await darnit(dir, "fix", "--dry-run", "--no-test")).stdout).not.toContain("\u001b");
    const json = await darnitWith(tty, dir, "fix", "--dry-run", "--no-test", "--json");
    expect((JSON.parse(json.stdout) as { diff: string }).diff).toContain(`+export const r = new OpenAI().chat.completions.create({ model: "x", messages: [], max_completion_tokens: 5 }); // ${codes}\n`);
  });

  it("gives fix --json the address and path as they are, and writes them out on screen", async () => {
    const local = 'import OpenAI from "openai";\nconst c = new OpenAI({ baseURL: "http://localhost:1\u202E\u001b[2Jabc/v1" });\nexport const r = c.chat.completions.create({ model: "x", messages: [], max_tokens: 5 });\n';
    const old = '{ "name": "openai", "version": "4.0.0" }';
    for (const [files, expected, written] of [
      [{ "local.ts": local }, "sent to localhost:1\u202E\u001b[2jabc, which may not be OpenAI", String.raw`needs a human: local.ts:3 (sent to localhost:1\u202e?[2jabc, which may not be OpenAI)`],
      [{ "w\u202E\nd/app.js": SDK_CALL, "w\u202E\nd/node_modules/openai/package.json": old }, `(${join("w\u202E\nd", "node_modules", "openai")})`, String.raw`(w\u202e?d/node_modules/openai); upgrade it first`],
    ] as const) {
      const dir = await repoWith(files);
      const json = await darnit(dir, "fix", "--dry-run", "--no-test", "--json");
      expect(json.stdout).not.toMatch(HIDDEN);
      const record = (JSON.parse(json.stdout) as { records: { reason: string; remaining: { note: string }[] }[] }).records[0]!;
      expect([record.reason, ...record.remaining.map((r) => r.note)].join("\n")).toContain(expected);
      const { stdout } = await darnit(dir, "fix", "--dry-run", "--no-test");
      expect(stdout).not.toMatch(HIDDEN);
      expect(stdout).toContain(written);
    }
    const note = "sent to localhost:1\u202E\u001b[2jabc, which may not be OpenAI";
    const body = prBody((await loadRecords())[0]!.record, ["local.ts"], "t", { remaining: [{ file: "local.ts", line: 3, note }] });
    expect(body).not.toContain("\u001b");
    expect(body).not.toContain("\u202E");
    expect(body).toContain("?[2jabc");
  });

  /**
   * Peak live heap of darnit running `args` in `cwd`, collected at its first write to stdout and then at least every
   * million characters, and the characters it wrote. Live heap, unlike resident memory, does not depend on when V8
   * gets round to collecting, so two runs doing the same work measure the same.
   */
  const liveWhileWriting = (cwd: string, args: string[]) =>
    new Promise<{ live: number; chars: number }>((resolve, reject) => {
      const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
      // No "%" in it: a data URL reads that as an escape.
      const hook =
        "data:text/javascript,let last=-1,live=0,chars=0;const write=process.stdout.write.bind(process.stdout);" +
        "process.stdout.write=(c,...r)=>{chars+=c.length;if(last<0||chars-last>=1048576){last=chars;gc();live=Math.max(live,process.memoryUsage().heapUsed)}return write(c,...r)};" +
        "process.on('exit',()=>process.stderr.write('live '+live+' chars '+chars+'\\n'))";
      const child = spawn(process.execPath, ["--expose-gc", "--import", import.meta.resolve("tsx"), "--import", hook, cli, ...args], {
        cwd,
        env: { ...process.env, DARNIT_NO_UPDATE_CHECK: "1" },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", () => {
        const [, live = NaN, chars = NaN] = (/live (\d+) chars (\d+)/.exec(stderr) ?? []).map(Number);
        resolve({ live, chars });
      });
    });

  it("holds no escaped copy of the output while writing it", async () => {
    const file = (chars: string) =>
      `import OpenAI from "openai";\nconst c = new OpenAI();\nexport const r = c.chat.completions.create({ max_tokens: cap("${chars.repeat(1_162_000)}") });\n`;
    // 9.3 MB each, with as many characters: U+202E, U+2066 and U+009B take 3, 3 and 2 bytes in UTF-8, as do 日, 本 and é.
    const crafted = await repoWith({ "app.ts": file("\u202E\u2066\u009b") });
    const plain = await repoWith({ "app.ts": file("日本é") });
    for (const args of [["check", "--json"], ["fix", "--dry-run", "--no-test"], ["fix", "--dry-run", "--no-test", "--json"]]) {
      const [hidden, ordinary] = await Promise.all([liveWhileWriting(crafted, args), liveWhileWriting(plain, args)]);
      // Both runs do the same work but for escaping, which makes the crafted output six times longer: holding even
      // one escaped copy of it would add at least its length in bytes.
      expect(hidden.chars, args.join(" ")).toBeGreaterThan(5 * ordinary.chars);
      expect(hidden.live - ordinary.live, args.join(" ")).toBeLessThan(hidden.chars / 4);
    }
  }, 180_000);
});

describe("fix checks package versions before rewriting", () => {
  const PY_CALL = "from openai import OpenAI\nr = OpenAI().chat.completions.create(model='x', messages=[], max_tokens=5)\n";

  it("refuses when the repo pins an SDK too old for the new parameter", async () => {
    const dir = await repoWith({ "app.py": PY_CALL, "requirements.txt": "openai==1.40.0\n" });
    const result = await fix(dir, { noTest: true });
    expect(result.records.map((r) => [r.applied, r.reason])).toEqual([[false, "needs openai >= 1.45.0, this repo has 1.40.0 (requirements.txt); upgrade it first"]]);
    expect(await readFile(join(dir, "app.py"), "utf8")).toBe(PY_CALL);
  });

  it("is not blocked by a stale side requirements file when the main pin is new enough", async () => {
    const dir = await repoWith({ "app.py": PY_CALL, "requirements.txt": "openai==1.50.0\n", "requirements-legacy.txt": "openai==0.28.1\n" });
    const result = await fix(dir, { noTest: true });
    expect(result.records[0]).toMatchObject({ applied: true });
    expect(await readFile(join(dir, "app.py"), "utf8")).toContain("max_completion_tokens=5");
  });

  it("checks the SDK the file actually uses in a monorepo, not an old hoisted copy", async () => {
    const dir = await repoWith({
      "apps/web/sdk.js": SDK_CALL,
      "apps/web/node_modules/openai/package.json": JSON.stringify({ version: "4.70.0" }),
      "node_modules/openai/package.json": JSON.stringify({ version: "4.20.0" }),
    });
    const result = await fix(dir, { noTest: true });
    expect(result.records[0]).toMatchObject({ applied: true });
    expect(result.records[0]?.unconfirmed).toBeUndefined();
  });

  it("blocks when requirements.txt is too old even if a side file pins a newer version", async () => {
    const dir = await repoWith({ "app.py": PY_CALL, "requirements.txt": "openai==1.40.0\n", "requirements-dev.txt": "openai==1.50.0\n" });
    const result = await fix(dir, { noTest: true });
    expect(result.records[0]?.reason).toBe("needs openai >= 1.45.0, this repo has 1.40.0 (requirements.txt); upgrade it first");
  });

  it("cannot confirm when the lock file holds both an old and a new version", async () => {
    const block = (v: string) => `[[package]]\nname = "openai"\nversion = "${v}"\n`;
    const dir = await repoWith({ "app.py": PY_CALL, "uv.lock": block("1.30.0") + block("1.52.0") });
    const result = await fix(dir, { noTest: true });
    expect(result.records[0]).toMatchObject({ applied: true, unconfirmed: ["openai >= 1.45.0 (PyPI)"] });
  });

  it("rewrites when the installed SDK is new enough", async () => {
    const dir = await repoWith({ "sdk.js": SDK_CALL, "node_modules/openai/package.json": JSON.stringify({ version: "4.70.0" }) });
    const result = await fix(dir, { noTest: true });
    expect(result.records[0]).toMatchObject({ applied: true });
    expect(result.records[0]?.unconfirmed).toBeUndefined();
    expect(renderSummary(result)).not.toContain("could not confirm");
  });

  it("rewrites but says so when it cannot tell the SDK version", async () => {
    const dir = await repoWith({ "sdk.js": SDK_CALL });
    const result = await fix(dir, { noTest: true });
    expect(result.records[0]).toMatchObject({ applied: true, unconfirmed: ["openai >= 4.60.0 (npm)"] });
    expect(renderSummary(result)).toContain("could not confirm openai >= 4.60.0 (npm)");
    const body = prBody(result.records[0]!.record, ["sdk.js"], "t", { unconfirmed: result.records[0]!.unconfirmed });
    expect(body).toContain("- This change needs openai >= 4.60.0 (npm); darnit could not find the version this repository uses.");
  });
});

// Stands in for a typecheck that rejects the new key, as TypeScript does on an SDK older than 4.60.0.
const STRICT_TYPECHECK = JSON.stringify({
  scripts: { typecheck: "node -e \"process.exit(require('fs').readFileSync('sdk.js','utf8').includes('max_completion_tokens') ? 1 : 0)\"" },
});

describe("fix runs the repo's build check", () => {
  it("puts the files back when the change breaks the build, and skips the tests", async () => {
    const dir = await repoWith({ "sdk.js": SDK_CALL, "package.json": STRICT_TYPECHECK });
    const result = await fix(dir);
    expect(result.build).toMatchObject({ kind: "build", command: "npm run typecheck", passed: false, attributed: "change" });
    expect(result.tests).toBeUndefined();
    expect(result.reverted).toBe(true);
    expect(exitCodeFor(result)).toBe(1);
    expect(renderSummary(result)).toContain("build: npm run typecheck failed; files put back. The change broke your build.");
    expect(renderSummary(result)).not.toContain("✓");
    expect(await readFile(join(dir, "sdk.js"), "utf8")).toBe(SDK_CALL);
  });

  it("keeps the change when the build was already failing, and says the build could not check it", async () => {
    const broken = JSON.stringify({ scripts: { build: "node -e \"process.exit(1)\"" } });
    const dir = await repoWith({ "sdk.js": SDK_CALL, "package.json": broken });
    const result = await fix(dir);
    expect(result.build).toMatchObject({ passed: false, attributed: "baseline", notChecked: true });
    expect(result.reverted).toBe(false);
    expect(exitCodeFor(result)).toBe(0);
    expect(renderSummary(result)).toContain("build: npm run build already fails without the change, so it could not check it; change kept");
    expect(await readFile(join(dir, "sdk.js"), "utf8")).toContain("max_completion_tokens: 5");
    const body = prBody(result.records[0]!.record, ["sdk.js"], "t", { build: result.build });
    expect(body).toContain("- [ ] `npm run build` already fails without this change, so it could not check it");
  });

  it("does not run a JavaScript build for a Python-only change", async () => {
    const pkg = JSON.stringify({ scripts: { build: "node -e \"process.exit(1)\"" } });
    const dir = await repoWith({ "app.py": "r = c.chat.completions.create(model='x', max_tokens=5)\n", "package.json": pkg });
    const result = await fix(dir, { test: "node -e 0" });
    expect(result.build).toBeUndefined();
    expect(result.tests).toMatchObject({ passed: true });
    expect(await readFile(join(dir, "app.py"), "utf8")).toContain("max_completion_tokens=5");
  });

  it("still says no tests were found when only the build ran", async () => {
    const pkg = JSON.stringify({ scripts: { typecheck: "node -e 0" } });
    const summary = renderSummary(await fix(await repoWith({ "sdk.js": SDK_CALL, "package.json": pkg })));
    expect(summary).toContain("build: npm run typecheck passed");
    expect(summary).toContain("tests: none found");
  });

  it("puts back tracked files the build wrote, but never the user's own edits", async () => {
    const pkg = JSON.stringify({ scripts: { build: "node -e \"require('fs').writeFileSync('dist/out.js', 'rebuilt')\"" } });
    const dir = await repoWith({ "sdk.js": SDK_CALL, "package.json": pkg, "dist/out.js": "committed", "notes.md": "committed" });
    await writeFile(join(dir, "notes.md"), "my uncommitted notes");
    const result = await fix(dir);
    expect(result.build).toMatchObject({ passed: true });
    expect(await readFile(join(dir, "dist/out.js"), "utf8")).toBe("committed");
    expect(await readFile(join(dir, "notes.md"), "utf8")).toBe("my uncommitted notes");
    expect(await readFile(join(dir, "sdk.js"), "utf8")).toContain("max_completion_tokens: 5");
  });

  it("reports a passing build alongside the tests", async () => {
    const pkg = JSON.stringify({ scripts: { typecheck: "node -e 0", test: "node -e 0" } });
    const result = await fix(await repoWith({ "sdk.js": SDK_CALL, "package.json": pkg }));
    const summary = renderSummary(result);
    expect(summary).toContain("build: npm run typecheck passed");
    expect(summary).toContain("tests: npm test passed");
    expect(exitCodeFor(result)).toBe(0);
  });
});

// One file calling OpenAI and Groq through the same method: the rename rule would rewrite both.
const MIXED_CLIENTS = `import OpenAI from "openai";
import Groq from "groq-sdk";
const openai = new OpenAI();
const groq = new Groq();
export const a = openai.chat.completions.create({ model: "x", messages: [], max_tokens: 5 });
export const b = groq.chat.completions.create({ model: "x", messages: [], max_tokens: 5 });
`;

describe("fix never rewrites another provider's calls", () => {
  it("leaves a file alone when it also calls a look-alike client", async () => {
    const dir = await repoWith({ "both.ts": MIXED_CLIENTS });
    const result = await fix(dir, { noTest: true });
    expect(result.records[0]).toMatchObject({
      applied: false,
      reason: "this file also calls another provider through the same methods, so the rewrite would change those calls too",
    });
    expect(await readFile(join(dir, "both.ts"), "utf8")).toBe(MIXED_CLIENTS);
  });

  it("names every held line when all the files are mixed", async () => {
    const dir = await repoWith({ "a.ts": MIXED_CLIENTS, "b.ts": MIXED_CLIENTS });
    const result = await fix(dir, { noTest: true, dryRun: true });
    const summary = renderSummary(result);
    expect(summary).toContain("found in 2 files, not rewritten: each of these files also calls another provider");
    expect(summary).toContain("needs a human: a.ts:5 (this file also calls another provider through the same methods)");
    expect(summary).toContain("needs a human: b.ts:5 (this file also calls another provider through the same methods)");
  });

  it.skipIf(process.platform === "win32")("keeps a crafted file name on one line in the summary", async () => {
    const dir = await repoWith({ "a\n::error::b.ts": MIXED_CLIENTS });
    const summary = renderSummary(await fix(dir, { noTest: true, dryRun: true }));
    expect(summary.split("\n").filter((l) => l.startsWith("::"))).toEqual([]);
    expect(summary).toContain("needs a human: a?::error::b.ts:5");
  });

  it("rewrites clean files and hands the mixed file to a human", async () => {
    const dir = await repoWith({ "both.ts": MIXED_CLIENTS, "sdk.js": SDK_CALL });
    const result = await fix(dir, { noTest: true });
    expect(result.records[0]).toMatchObject({ applied: true, sites: 2 });
    const summary = renderSummary(result);
    expect(summary).toContain("1 of 2 call sites rewritten");
    expect(summary).toContain("needs a human: both.ts:5 (this file also calls another provider through the same methods)");
    expect(await readFile(join(dir, "both.ts"), "utf8")).toBe(MIXED_CLIENTS);
    expect(await readFile(join(dir, "sdk.js"), "utf8")).toContain("max_completion_tokens: 5");
    const body = prBody(result.records[0]!.record, ["sdk.js"], "t", { remaining: result.records[0]!.remaining });
    expect(body).toContain("- `both.ts:5`: this file also calls another provider through the same methods");
    expect(body).toContain("OpenAI announced this change on 2024-09-12");
  });
});

// OpenAI's SDK pointed at a local server, which may not accept the new parameter.
const LOCAL_CALL = `import OpenAI from "openai";
const ollama = new OpenAI({ baseURL: "http://localhost:11434/v1", apiKey: "ollama" });
export const r = ollama.chat.completions.create({ model: "llama3", messages: [], max_tokens: 5 });
`;

describe("fix leaves calls sent to a local address to a human", () => {
  it("rewrites the OpenAI call and holds the local one", async () => {
    const dir = await repoWith({ "local.ts": LOCAL_CALL, "sdk.js": SDK_CALL });
    const result = await fix(dir, { noTest: true });
    expect(result.records[0]).toMatchObject({ applied: true, sites: 2 });
    expect(renderSummary(result)).toContain("needs a human: local.ts:3 (sent to localhost:11434, which may not be OpenAI)");
    expect(await readFile(join(dir, "local.ts"), "utf8")).toBe(LOCAL_CALL);
    expect(await readFile(join(dir, "sdk.js"), "utf8")).toContain("max_completion_tokens: 5");
  });

  it("holds a whole file that mixes a local call and an OpenAI call", async () => {
    const both = `${LOCAL_CALL}const openai = new OpenAI();\nexport const s = openai.chat.completions.create({ model: "x", messages: [], max_tokens: 5 });\n`;
    const dir = await repoWith({ "both.ts": both });
    const result = await fix(dir, { noTest: true });
    expect(result.records[0]).toMatchObject({ applied: false, reason: "this file sends calls to a private address, which may not be OpenAI" });
    expect(await readFile(join(dir, "both.ts"), "utf8")).toBe(both);
    const summary = renderSummary(result);
    expect(summary).toContain("needs a human: both.ts:3 (sent to localhost:11434, which may not be OpenAI)");
    expect(summary).toContain("needs a human: both.ts:5 (this file also sends calls to a private address)");
  });

  it("names both reasons when local files and look-alike files are held together", async () => {
    const dir = await repoWith({ "local.ts": LOCAL_CALL, "groq.ts": MIXED_CLIENTS });
    const result = await fix(dir, { noTest: true, dryRun: true });
    expect(result.records[0]!.reason).toBe("each of these files also calls another provider or a private address, so the rewrite would change those calls too");
  });

  it("says this file when one file holds both a look-alike call and a local call", async () => {
    const dir = await repoWith({ "all.ts": `${MIXED_CLIENTS}const ollama = new OpenAI({ baseURL: "http://localhost:11434/v1" });\nexport const c = ollama.chat.completions.create({ model: "x", messages: [], max_tokens: 5 });\n` });
    const result = await fix(dir, { noTest: true, dryRun: true });
    expect(result.records[0]!.reason).toBe("this file also calls another provider or a private address, so the rewrite would change those calls too");
  });
});

describe("fix verifies its own rewrites", () => {
  it("does not claim a rewrite it did not make", async () => {
    const dir = await repoWith({ "client.js": RAW_FETCH });
    for (const dryRun of [true, false]) {
      const result = await fix(dir, { noTest: true, dryRun });
      expect(result.records.map((r) => [r.applied, r.reason])).toEqual([[false, "the rewrite rules don't cover this call shape yet"]]);
      expect(result.diff).toBe("");
      expect(renderSummary(result)).toBe(
        "- Rename max_tokens to max_completion_tokens on chat completions: found in 1 file, not rewritten: the rewrite rules don't cover this call shape yet",
      );
      expect(await tree(dir)).toEqual({ "client.js": RAW_FETCH });
    }
  });

  it("puts files back when a rewrite changed bytes but removed no call site", async () => {
    // A broken pack: its rule edits a neighbouring key and never touches max_tokens.
    const pack = await mkdtemp(join(tmpdir(), "darnit-pack-"));
    tempDirs.push(pack);
    await mkdir(join(pack, "rules", "js"), { recursive: true });
    await writeFile(
      join(pack, "rules", "js", "01-wrong.yml"),
      "id: wrong\nlanguage: javascript\nrule:\n  pattern:\n    context: '({ model: $M })'\n    selector: pair\nfix: 'engine: $M'\n",
    );
    const dir = await repoWith({ "sdk.js": SDK_CALL });
    const record = (await loadRecords()).find((l) => l.record.id.includes("max-tokens"))!.record;
    const outcome = await applyAndVerify(dir, { record, packDir: pack, files: ["sdk.js"], sites: 1, sitesIn: { "sdk.js": 1 } });
    expect(outcome).toEqual({ changed: [], remaining: [{ file: "sdk.js", line: 2 }] });
    expect(await readFile(join(dir, "sdk.js"), "utf8")).toBe(SDK_CALL);
  });

  it("does not list leftovers under a partial rewrite that was put back", async () => {
    const dir = await repoWith({ "client.js": RAW_FETCH, "sdk.js": SDK_CALL });
    const result = await fix(dir, { test: "node -e \"process.exit(1)\"" });
    const summary = renderSummary(result);
    expect(summary).toContain("rewritten, then put back");
    expect(summary).not.toContain("needs a human");
  });

  it("reports the call sites a partial rewrite left behind", async () => {
    const dir = await repoWith({ "client.js": RAW_FETCH, "sdk.js": SDK_CALL });
    for (const dryRun of [true, false]) {
      const result = await fix(dir, { noTest: true, dryRun });
      expect(result.records[0]).toMatchObject({ applied: true, sites: 2, remaining: [{ file: "client.js", line: 4 }] });
      const summary = renderSummary(result);
      expect(summary).toContain("1 of 2 call sites rewritten");
      expect(summary).toContain("needs a human: client.js:4");
      expect(result.diff).toContain("+export const r = new OpenAI().chat.completions.create({ model: \"x\", messages: [], max_completion_tokens: 5 });");
      expect(result.diff).not.toContain("client.js");
    }
  });

  it("never reads the repo's own ast-grep config", async () => {
    // A custom language in sgconfig.yml makes ast-grep load a native library from the repo.
    const sgconfig = "customLanguages:\n  evil:\n    libraryPath: evil.so\n    extensions: [evil]\n";
    const dir = await repoWith({ "sdk.js": SDK_CALL, "sgconfig.yml": sgconfig });
    // ast-grep also looks in every folder above its working directory, so plant one above the temp folders too.
    const parent = await mkdtemp(join(tmpdir(), "darnit-parent-"));
    tempDirs.push(parent);
    await writeFile(join(parent, "sgconfig.yml"), sgconfig);
    const cwd = process.cwd();
    const tmp = process.env.TMPDIR;
    process.chdir(dir);
    process.env.TMPDIR = parent;
    try {
      const result = await fix(dir, { noTest: true, dryRun: true });
      expect(result.records.map((r) => r.applied)).toEqual([true]);
    } finally {
      process.chdir(cwd);
      if (tmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = tmp;
    }
  });
});

describe("fix", () => {
  it("says why tests did not run when a pytest setup has no Python to run it", async () => {
    const dir = await repoWith({ "pytest.ini": "", "app.py": "c.chat.completions.create(model='x', max_tokens=5)\n" });
    // A PATH with git and nothing else, so no python3 or python is found.
    const bin = await mkdtemp(join(tmpdir(), "darnit-bin-"));
    tempDirs.push(bin);
    for (const d of (process.env.PATH ?? "").split(delimiter)) {
      if (await access(join(d, "git")).then(() => true, () => false)) {
        await symlink(join(d, "git"), join(bin, "git"));
        break;
      }
    }
    vi.stubEnv("PATH", bin);
    try {
      const result = await fix(dir);
      expect(result.testsNote).toBe("found a pytest setup but no python3 or python on PATH");
      expect(renderSummary(result)).toContain("tests: none run (found a pytest setup but no python3 or python on PATH)");
      const unread = await repoWith({ "pytest.ini": "", "app.py": "c.chat.completions.create(model='x', max_tokens=5)\n" });
      await symlink("/dev/zero", join(unread, "pyproject.toml"));
      expect(renderSummary(await fix(unread))).toContain(
        "tests: none run (pyproject.toml could not be read; found a pytest setup but no python3 or python on PATH)",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("names a package.json it could not read instead of guessing the tests or the build", async () => {
    const big = JSON.stringify({ scripts: { test: "vitest" }, pad: "x".repeat(10.1 * 1024 * 1024) });
    const py = renderSummary(await fix(await repoWith({ "package.json": big, "app.py": "c.chat.completions.create(model='x', max_tokens=5)\n" })));
    expect(py).toContain("tests: none run (package.json could not be read; pass the command with --test)");
    // The build check only runs for JavaScript and TypeScript changes.
    expect(py).not.toContain("build:");
    const ts = await repoWith({ "app.ts": "c.chat.completions.create({ model: 'x', max_tokens: 5 });\n" });
    await mkdir(join(ts, "package.json"));
    expect(renderSummary(await fix(ts))).toContain("build: none run (package.json could not be read)");
  });

  it("turns every pack's before/ into its after/, touching only reported files", async () => {
    for (const { record, packDir } of await loadRecords()) {
      if (record.status !== "reviewed" || record.classification !== "mechanical") continue;
      const dir = await repoFrom(join(packDir, "fixtures", "basic", "before"));
      const result = await fix(dir, { noTest: true });
      expect(result.records.map((r) => r.record.id)).toEqual([record.id]);
      expect(await tree(dir)).toEqual(await tree(join(packDir, "fixtures", "basic", "after")));
      expect(result.diff).toContain("diff --git");
    }
  });

  it("reports a semantic change but leaves its files alone", async () => {
    const before = join(PACKS, "openai", "2023-11-06-chat-functions-to-tools", "fixtures", "basic", "before");
    const dir = await repoFrom(before);
    const result = await fix(dir, { noTest: true });
    // The sample also names gpt-4, which is shutting down: a second report-only change.
    expect(result.records.map((r) => [r.applied, r.reason])).toEqual([
      [false, "migration not yet automated; see the record notes"],
      [false, "migration not yet automated; see the record notes"],
    ]);
    expect(await tree(dir)).toEqual(await tree(before));
  });

  it("--dry-run leaves the tree untouched and still shows the diff", async () => {
    const before = join(PACKS, "openai", "2024-09-12-max-tokens-to-max-completion-tokens", "fixtures", "basic", "before");
    const dir = await repoFrom(before);
    const result = await fix(dir, { dryRun: true });
    expect(await tree(dir)).toEqual(await tree(before));
    expect(result.diff).toContain("+    max_completion_tokens: 256");
    expect(result.diff).not.toContain("darnit-dry-");
  });

  it("refuses outside a git repository unless --dry-run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "darnit-nogit-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "app.js"), 'import OpenAI from "openai";\nnew OpenAI().chat.completions.create({ max_tokens: 1 });\n');
    await expect(fix(dir)).rejects.toBeInstanceOf(Refusal);
    expect((await fix(dir, { dryRun: true })).diff).toContain("max_completion_tokens");
  });

  const NOT_CHECKED_OUT = "not a checked-out git repository; darnit only edits files it can undo. Use --dry-run to preview.";

  it("refuses a bare repository, a .git folder and a plain folder before touching a file, unless --dry-run", async () => {
    const work = await repoWith({ "sdk.js": SDK_CALL });
    const parent = await mkdtemp(join(tmpdir(), "darnit-bare-"));
    tempDirs.push(parent);
    for (const name of ["bare.git", "empty.git"]) await promisify(execFile)("git", ["clone", "-q", "--bare", work, name], { cwd: parent });
    await mkdir(join(parent, "plain"));
    // Each has a fixable file, except empty.git, where there is nothing to fix but darnit still cannot undo.
    const places = [join(parent, "bare.git"), join(work, ".git"), join(work, ".git", "refs"), join(parent, "plain")];
    for (const p of places) await writeFile(join(p, "sdk.js"), SDK_CALL);
    for (const p of [...places, join(parent, "empty.git")]) {
      for (const opts of [{}, { noTest: true }, { pr: true }, { pr: true, allowDirty: true }]) {
        const err = await fix(p, opts).catch((e: unknown) => e);
        expect(err, p).toBeInstanceOf(Refusal);
        expect((err as Error).message, p).toBe(NOT_CHECKED_OUT);
      }
      expect(await darnit(parent, "fix", p)).toEqual({ code: 2, stdout: "", stderr: `darnit: ${NOT_CHECKED_OUT}\n` });
      expect(await darnit(parent, "fix", "--pr", "--allow-dirty", p)).toEqual({ code: 2, stdout: "", stderr: `darnit: ${NOT_CHECKED_OUT}\n` });
      if (p.endsWith("empty.git")) continue;
      expect(await readFile(join(p, "sdk.js"), "utf8"), p).toBe(SDK_CALL);
      expect((await fix(p, { dryRun: true })).diff, p).toContain("max_completion_tokens");
    }
  });

  it("works on a subdirectory or a linked worktree of a repository as on the folder itself", async () => {
    const dir = await repoWith({ "sdk.js": SDK_CALL, "sub/sdk.js": SDK_CALL });
    const wt = join(await mkdtemp(join(tmpdir(), "darnit-wt-")), "wt");
    tempDirs.push(dirname(wt));
    await git(dir, ["worktree", "add", "-q", "--detach", wt]);
    // Only files under the subdirectory are rewritten.
    expect((await fix(join(dir, "sub"), { noTest: true })).diff).toContain("max_completion_tokens");
    expect(await git(dir, ["status", "--porcelain"])).toBe(" M sub/sdk.js\n");
    expect((await fix(wt, { noTest: true })).diff).toContain("max_completion_tokens");
    expect(await git(wt, ["status", "--porcelain"])).toBe(" M sdk.js\n M sub/sdk.js\n");
    expect(await readFile(join(dir, "sdk.js"), "utf8")).toBe(SDK_CALL);
  });

  const NO_COMMITS = "the current branch has no commits yet; commit your files first. Use --dry-run to preview.";

  it("refuses a repository with no commits before touching a file, unless --dry-run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "darnit-nohead-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "sdk.js"), SDK_CALL);
    await git(dir, ["init", "-q"]);
    const id = "openai:2024-09-12:max-tokens-to-max-completion-tokens";
    for (const opts of [{}, { noTest: true }, { only: [id] }, { pr: true, allowDirty: true }]) {
      const err = await fix(dir, opts).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Refusal);
      expect((err as Error).message).toBe(NO_COMMITS);
      expect(await readFile(join(dir, "sdk.js"), "utf8")).toBe(SDK_CALL);
    }
    expect((await fix(dir, { dryRun: true })).diff).toContain("max_completion_tokens");
    expect(await readFile(join(dir, "sdk.js"), "utf8")).toBe(SDK_CALL);

    expect(await darnit(dir, "fix", "--json")).toEqual({ code: 2, stdout: "", stderr: `darnit: ${NO_COMMITS}\n` });
    expect(await readFile(join(dir, "sdk.js"), "utf8")).toBe(SDK_CALL);
  });

  const UNSAFE = /^uncommitted changes in files darnit needs to edit: sdk\.js; commit or stash them first so git can undo the rewrite, or preview with --dry-run$/;

  it("refuses to rewrite a file git does not track, and leaves it byte for byte", async () => {
    const dir = await repoWith({ "README.md": "hi\n" });
    await writeFile(join(dir, "sdk.js"), SDK_CALL);
    const before = await readFile(join(dir, "sdk.js"));
    for (const opts of [{}, { noTest: true }]) await expect(fix(dir, opts)).rejects.toThrow(UNSAFE);
    const cli = await darnit(dir, "fix", "--no-test");
    expect(cli).toMatchObject({ code: 2, stdout: "" });
    expect(cli.stderr.trimEnd()).toMatch(new RegExp(`^darnit: ${UNSAFE.source.slice(1)}`));
    expect((await readFile(join(dir, "sdk.js"))).equals(before)).toBe(true);
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("?? sdk.js");
    expect((await fix(dir, { dryRun: true })).diff).toContain("max_completion_tokens");
  });

  const commitAll = async (dir: string) => {
    await git(dir, ["add", "-A"]);
    await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x"]);
  };
  // Each leaves a file with a fixable call that git could not put back as it is; returns its name.
  const unsafe: [string, (dir: string) => Promise<string>][] = [
    ["ignored", async (dir) => {
      await writeFile(join(dir, ".git", "info", "exclude"), "new.js\n");
      await writeFile(join(dir, "new.js"), SDK_CALL);
      return "new.js";
    }],
    ["edited", async (dir) => {
      await appendFile(join(dir, "sdk.js"), "// mine\n");
      return "sdk.js";
    }],
    ["converted to CRLF where .gitattributes stores LF", async (dir) => {
      await writeFile(join(dir, ".gitattributes"), "*.js text eol=lf\n");
      await commitAll(dir);
      await writeFile(join(dir, "sdk.js"), SDK_CALL.replaceAll("\n", "\r\n"));
      return "sdk.js";
    }],
    ["edited and staged", async (dir) => {
      await appendFile(join(dir, "sdk.js"), "// mine\n");
      await git(dir, ["add", "sdk.js"]);
      return "sdk.js";
    }],
    ["new and staged", async (dir) => {
      await writeFile(join(dir, "new.js"), SDK_CALL);
      await git(dir, ["add", "new.js"]);
      return "new.js";
    }],
    ["marked assume-unchanged", async (dir) => {
      await git(dir, ["update-index", "--assume-unchanged", "sdk.js"]);
      await appendFile(join(dir, "sdk.js"), "// mine\n");
      return "sdk.js";
    }],
    ["marked skip-worktree", async (dir) => {
      await git(dir, ["update-index", "--skip-worktree", "sdk.js"]);
      await appendFile(join(dir, "sdk.js"), "// mine\n");
      return "sdk.js";
    }],
    ["inside a submodule", async (dir) => {
      const lib = await repoWith({ "new.js": SDK_CALL });
      await promisify(execFile)("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "lib"], { cwd: dir });
      await commitAll(dir);
      return "lib/new.js";
    }],
    ["inside a nested repository", async (dir) => {
      await mkdir(join(dir, "nested"));
      await writeFile(join(dir, "nested", "new.js"), SDK_CALL);
      await git(join(dir, "nested"), ["init", "-q"]);
      await commitAll(join(dir, "nested"));
      return "nested/new.js";
    }],
  ];

  it.each(unsafe)("refuses a file that is %s, with or without --pr", async (_, setup) => {
    const dir = await repoWith({ "sdk.js": SDK_CALL });
    const file = await setup(dir);
    const before = await readFile(join(dir, file));
    for (const opts of [{}, { pr: true, allowDirty: true, noTest: true, repo: "o/r" }]) {
      await expect(fix(dir, opts)).rejects.toThrow(`files darnit needs to edit: ${file};`);
      expect((await readFile(join(dir, file))).equals(before)).toBe(true);
    }
    expect((await git(dir, ["branch", "--list", "darnit/*"])).trim()).toBe("");
  });

  it("checks files by their path from a subfolder of the repository", async () => {
    const dir = await repoWith({ "app/sdk.js": SDK_CALL, "app/b.js": SDK_CALL });
    await appendFile(join(dir, "app", "b.js"), "// mine\n");
    await expect(fix(join(dir, "app"), { noTest: true })).rejects.toThrow("files darnit needs to edit: b.js;");
    await git(dir, ["checkout", "--", "app/b.js"]);
    expect((await fix(join(dir, "app"), { noTest: true })).records[0]).toMatchObject({ applied: true });
    await writeFile(join(dir, "app", "new.js"), SDK_CALL);
    await expect(fix(join(dir, "app"), { noTest: true })).rejects.toThrow("files darnit needs to edit: new.js;");
  });

  it("reads a staged rename's source path as a path, not as a status line", async () => {
    // Read as a status line, "ab/sdk.js" would lose its first three characters and name sdk.js.
    const dir = await repoWith({ "sdk.js": SDK_CALL, "ab/sdk.js": "notes\n" });
    await git(dir, ["mv", "ab/sdk.js", "moved.md"]);
    expect((await fix(dir, { noTest: true })).records[0]).toMatchObject({ applied: true });
  });

  it("says when a file's name differs from git's only in case", async () => {
    const dir = await repoWith({ "SDK.js": SDK_CALL, "b.js": SDK_CALL });
    // Git sets core.ignorecase on a disk that ignores case, as on macOS and Windows, where this rename leaves git status clean.
    await git(dir, ["config", "core.ignorecase", "true"]);
    await rename(join(dir, "SDK.js"), join(dir, "sdk.js"));
    const before = await readFile(join(dir, "sdk.js"));
    await expect(fix(dir, { noTest: true })).rejects.toThrow(
      /^files darnit needs to edit differ only in case from the names git has: sdk\.js \(git has SDK\.js\); rename them back or commit the rename first, or preview with --dry-run$/,
    );
    await appendFile(join(dir, "b.js"), "// mine\n");
    await expect(fix(dir, { noTest: true })).rejects.toThrow(
      "uncommitted changes in files darnit needs to edit: b.js; commit or stash them first so git can undo the rewrite; files darnit needs to edit differ only in case from the names git has: sdk.js (git has SDK.js);",
    );
    await git(dir, ["config", "core.ignorecase", "false"]);
    await expect(fix(dir, { noTest: true })).rejects.toThrow("uncommitted changes in files darnit needs to edit: b.js, sdk.js;");
    expect((await readFile(join(dir, "sdk.js"))).equals(before)).toBe(true);
  });

  it("names the first five files it refused and counts the rest", async () => {
    const dir = await repoWith({ "README.md": "hi\n" });
    for (const n of [1, 2, 3, 4, 5, 6, 7]) await writeFile(join(dir, `sdk${n}.js`), SDK_CALL);
    await expect(fix(dir)).rejects.toThrow("files darnit needs to edit: sdk1.js, sdk2.js, sdk3.js, sdk4.js, sdk5.js and 2 more;");
  });

  it("still fixes a clean tracked file when other files are untracked or edited", async () => {
    const dir = await repoWith({ 'é "q".js': SDK_CALL, "notes.md": "committed" });
    await writeFile(join(dir, "notes.md"), "mine");
    await writeFile(join(dir, "todo.txt"), "mine");
    const result = await fix(dir, { noTest: true });
    expect(result.records[0]).toMatchObject({ applied: true });
    expect(await readFile(join(dir, 'é "q".js'), "utf8")).toContain("max_completion_tokens: 5");
    expect(await readFile(join(dir, "notes.md"), "utf8")).toBe("mine");
  });

  it("puts the files back when git fails after the rewrite", async () => {
    const dir = await repoWith({ "sdk.js": SDK_CALL });
    await writeFile(join(dir, ".git", "index"), "junk\n");
    await expect(fix(dir, { noTest: true })).rejects.toThrow(/index/);
    expect(await readFile(join(dir, "sdk.js"), "utf8")).toBe(SDK_CALL);
    expect((await darnit(dir, "fix", "--no-test")).code).toBe(2);
    expect(await readFile(join(dir, "sdk.js"), "utf8")).toBe(SDK_CALL);
  });

  it("refuses an unknown --only id", async () => {
    const dir = await repoFrom(join(PACKS, "openai", "2024-09-12-max-tokens-to-max-completion-tokens", "fixtures", "basic", "before"));
    await expect(fix(dir, { only: ["openai:2020-01-01:nope"], noTest: true })).rejects.toThrow(/unknown change record/);
  });

  it("puts files back when the change breaks the tests and says so", async () => {
    const before = join(PACKS, "openai", "2024-09-12-max-tokens-to-max-completion-tokens", "fixtures", "basic", "before");
    const dir = await repoFrom(before);
    const asserting = "node -e \"process.exit(require('fs').readFileSync('app.js','utf8').includes('max_completion_tokens') ? 1 : 0)\"";
    const result = await fix(dir, { test: asserting });
    expect(result.reverted).toBe(true);
    expect(result.tests?.passed).toBe(false);
    expect(result.tests?.attributed).toBe("change");
    expect(await tree(dir)).toEqual(await tree(before));
    expect(renderSummary(result)).toContain("The change broke your tests.");
  });

  it("tells already-failing tests apart from ones the change broke", async () => {
    const before = join(PACKS, "openai", "2024-09-12-max-tokens-to-max-completion-tokens", "fixtures", "basic", "before");
    const dir = await repoFrom(before);
    const result = await fix(dir, { test: "node -e \"process.exit(1)\"" });
    expect(result.reverted).toBe(true);
    expect(result.tests?.attributed).toBe("baseline");
    const summary = renderSummary(result);
    expect(summary).toContain("already fail without the change. Fix them first, or rerun with --no-test to apply it without the tests or the build check.");
    // A rewrite that was put back is never shown with a check mark.
    expect(summary).toContain("✗ Rename max_tokens to max_completion_tokens on chat completions: rewritten, then put back");
    expect(summary).not.toContain("✓");
  });

  it("runs the detected npm test script and reports it", async () => {
    const before = join(PACKS, "openai", "2024-09-12-max-tokens-to-max-completion-tokens", "fixtures", "basic", "before");
    const dir = await repoFrom(before);
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "t", scripts: { test: "node -e \"process.exit(0)\"" } }));
    await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
    await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "pkg"]);
    const result = await fix(dir);
    expect(result.tests).toMatchObject({ command: "npm test", passed: true });
    expect(renderSummary(result)).toContain("tests: npm test passed");
  });
});

const HANGS = "node -e \"setTimeout(() => {}, 60000)\"";
// Fails at once on the rewritten file and hangs on the original, so only the second run times out.
const GATE = "if (require('fs').readFileSync('sdk.js', 'utf8').includes('max_completion_tokens')) process.exit(1); setTimeout(() => {}, 60000);\n";
const gated = (kind: "build" | "tests") =>
  kind === "build"
    ? { files: { "sdk.js": SDK_CALL, "gate.cjs": GATE, "package.json": JSON.stringify({ scripts: { typecheck: "node gate.cjs" } }) }, test: "node -e 0" }
    : { files: { "sdk.js": SDK_CALL, "gate.cjs": GATE }, test: "node gate.cjs" };

describe("fix when a check runs out of time", () => {
  it("says the tests timed out, without running them again or judging the change", async () => {
    runs.limitMs = 500;
    const dir = await repoWith({ "sdk.js": SDK_CALL });
    const result = await fix(dir, { test: HANGS });
    expect(runs.count).toBe(1);
    expect(result.tests).toMatchObject({ kind: "tests", passed: false, timedOut: true });
    expect(result.tests?.attributed).toBeUndefined();
    expect(result.reverted).toBe(true);
    expect(exitCodeFor(result)).toBe(1);
    const summary = renderSummary(result);
    expect(summary).toContain(`tests: ${HANGS} timed out after 10 minutes; files put back, since a run that did not finish can't check the change.`);
    expect(summary).not.toMatch(/broke|already fail/);
    expect(await readFile(join(dir, "sdk.js"), "utf8")).toBe(SDK_CALL);
    expect(toJson(result)).toMatchObject({ tests: { kind: "tests", passed: false, timedOut: true, notChecked: false } });
  });

  it("stops at a build that timed out: files put back, tests not run", async () => {
    runs.limitMs = 500;
    const dir = await repoWith({ "sdk.js": SDK_CALL, "package.json": JSON.stringify({ scripts: { typecheck: HANGS } }) });
    const result = await fix(dir, { test: "node -e 0" });
    expect(runs.count).toBe(1);
    expect(result.build).toMatchObject({ kind: "build", passed: false, timedOut: true });
    expect(result.build?.attributed).toBeUndefined();
    expect(result.build?.notChecked).toBeUndefined();
    expect(result.tests).toBeUndefined();
    expect(exitCodeFor(result)).toBe(1);
    expect(renderSummary(result)).toContain("build: npm run typecheck timed out after 10 minutes; files put back");
    expect(await readFile(join(dir, "sdk.js"), "utf8")).toBe(SDK_CALL);
  });

  it.each(["build", "tests"] as const)("gives no verdict when the %s run fails with the change and then times out without it", async (kind) => {
    runs.limitMs = 2000;
    const { files, test } = gated(kind);
    const dir = await repoWith(files);
    const result = await fix(dir, { test });
    expect(runs.count).toBe(2);
    expect(result[kind]).toMatchObject({ kind, passed: false, timedOut: true });
    expect(result[kind]?.attributed).toBeUndefined();
    expect(result[kind]?.notChecked).toBeUndefined();
    expect(result.reverted).toBe(true);
    expect(exitCodeFor(result)).toBe(1);
    expect(renderSummary(result)).toContain(`${kind}: ${kind === "build" ? "npm run typecheck" : test} timed out after 10 minutes; files put back`);
    expect(renderSummary(result)).not.toMatch(/broke|already fail/);
    expect(await readFile(join(dir, "sdk.js"), "utf8")).toBe(SDK_CALL);
  });
});

/**
 * The workflow commands GitHub's runner would act on in `output`: a line that starts with `::` once leading
 * whitespace is dropped, or the legacy `##[name]` anywhere in a line, except between `::stop-commands::<token>`
 * and `::<token>::`. Also whether it ends stopped. Whitespace is what .NET's TrimStart drops (U+0085 among it)
 * and what JavaScript's does (U+FEFF too), so this can report more than the runner, never less.
 */
function workflowCommands(output: string): { ran: string[]; stopped: boolean } {
  const ran: string[] = [];
  let token: string | undefined;
  for (const line of output.split(/\r\n|\r|\n/)) {
    const [command, name, data] = /^[\s\u0085]*::([^\s:]+)[^:]*::(.*)$/.exec(line) ?? /##\[([^\s\]]+)[^\]]*\](.*)$/.exec(line) ?? [];
    if (command === undefined || name === undefined) continue;
    if (token !== undefined) {
      if (name.toLowerCase() === token.toLowerCase()) token = undefined;
    } else {
      if (name === "stop-commands") token = data;
      ran.push(command);
    }
  }
  return { ran, stopped: token !== undefined };
}

/** The commands in `output` other than the fences darnit puts around repository text. */
const notDarnits = (output: string) => {
  const { ran, stopped } = workflowCommands(output);
  return { ran: ran.filter((c) => !/^::stop-commands::[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(c)), stopped };
};

describe("workflowCommands", () => {
  it("drops the leading whitespace the runner drops, and finds ##[ anywhere", () => {
    const lines = ["\u0085::error::a", "\u3000\t::warning::b", "\ufeff::debug::c", "x ##[error]d", "::e"];
    expect(workflowCommands(lines.join("\n")).ran).toEqual(["\u0085::error::a", "\u3000\t::warning::b", "\ufeff::debug::c", "##[error]d"]);
  });
});

describe("fix in GitHub Actions", () => {
  const LINES = ["::error::pwned", "  ::warning::indented", "\t::add-mask::tabbed", "ok #1 ##[add-mask]x", "::stop-commands::x", "::error::after"];
  const NOTICE = "::notice::darnit 9.0.0 is out";

  it("prints no line of the repository's test output as a workflow command, and leaves darnit's own working", async () => {
    const dir = await repoWith({ "sdk.js": SDK_CALL, "noise.js": `console.log(${JSON.stringify(LINES.join("\n"))}); process.exit(1);\n` });
    const run = await darnitWith({ GITHUB_ACTIONS: "true" }, dir, "fix", "--test", "node noise.js");
    expect(run.code).not.toBe(2);
    expect(run.stdout).toContain("::error::pwned\n  ::warning::indented\n\t::add-mask::tabbed\nok #1 ##[add-mask]x\n::stop-commands::x");
    expect(notDarnits(run.stdout + run.stderr)).toEqual({ ran: [], stopped: false });
    expect(notDarnits(`${run.stdout}${NOTICE}\n`).ran).toEqual([NOTICE]);
    const json = await darnitWith({ GITHUB_ACTIONS: "true" }, dir, "fix", "--test", "node noise.js", "--json");
    expect((JSON.parse(json.stdout) as { tests: { output: string } }).tests.output).toContain(LINES.join("\n"));
    expect(json.stdout).not.toContain("#");
    expect(notDarnits(json.stdout)).toEqual({ ran: [], stopped: false });
  });

  it("prints no file name from check --json as a workflow command, and keeps it exact", async () => {
    const dir = await repoWith({ "pkg#1##[error]pwned.js": SDK_CALL });
    const run = await darnitWith({ GITHUB_ACTIONS: "true" }, dir, "check", "--json");
    expect((JSON.parse(run.stdout) as { hits: { file: string }[] }).hits.map((h) => h.file)).toEqual(["pkg#1##[error]pwned.js"]);
    expect(run.stdout).not.toContain("#");
    expect(notDarnits(run.stdout)).toEqual({ ran: [], stopped: false });
  });

  it("prints no file name or snippet from check as a workflow command", async () => {
    const dir = await repoWith({ "::error::pwned.js": SDK_CALL, "b.js": SDK_CALL });
    const run = await darnitWith({ GITHUB_ACTIONS: "true" }, dir, "check");
    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/^\s*::error::pwned\.js:/m);
    expect(notDarnits(run.stdout + run.stderr)).toEqual({ ran: [], stopped: false });
  });

  it("prints no file name in an error as a workflow command", async () => {
    const dir = await repoWith({ "README.md": "hi\n" });
    await writeFile(join(dir, "##[error]pwned.js"), SDK_CALL);
    const run = await darnitWith({ GITHUB_ACTIONS: "true" }, dir, "fix", "--no-test");
    expect(run).toMatchObject({ code: 2, stdout: "" });
    expect(run.stderr).toContain("darnit needs to edit: ##[error]pwned.js;");
    expect(notDarnits(run.stderr)).toEqual({ ran: [], stopped: false });
  });

  it("prints no file name from init as a workflow command, inside one fence", async () => {
    const dir = await repoWith({ "##[error]pwned.py": "import openai\n" });
    const run = await darnitWith({ GITHUB_ACTIONS: "true" }, dir, "init");
    expect(run.stdout).toContain("found openai (##[error]pwned.py: import openai)");
    expect(notDarnits(run.stdout)).toEqual({ ran: [], stopped: false });
    expect(run.stdout.match(/^::stop-commands::/gm)).toHaveLength(1);
  });

  it("prints no line of fix's diff as a workflow command", async () => {
    // Git heads a hunk with the nearest line above it that starts with a letter, and indents context lines by one space.
    const py = 'x ##[error]E5\n"""\n1\n2\n::stop-commands::E7\n"""\nfrom openai import OpenAI\nr = OpenAI().chat.completions.create(model=\'x\', messages=[], max_tokens=5)\n';
    const dir = await repoWith({ "app.py": py, "requirements.txt": "openai==1.50.0\n" });
    const run = await darnitWith({ GITHUB_ACTIONS: "true" }, dir, "fix", "--dry-run", "--no-test");
    expect(run.stdout).toMatch(/^@@ .* @@ x ##\[error\]E5$/m);
    expect(run.stdout).toContain("\n ::stop-commands::E7\n");
    expect(notDarnits(run.stdout + run.stderr)).toEqual({ ran: [], stopped: false });
  });

  it("prints repository text that setup-node's problem matchers annotate, which the workflow init writes removes first", async () => {
    const owners = Object.keys(SETUP_NODE_MATCHERS);
    const tests = await repoWith({ "sdk.js": SDK_CALL, "noise.js": 'console.log("src/x.ts(1,1): error TS2322: pwned"); process.exit(1);\n' });
    const fixed = await darnitWith({ GITHUB_ACTIONS: "true" }, tests, "fix", "--test", "node noise.js");
    expect(annotations(fixed.stdout + fixed.stderr, owners)).toEqual(["tsc: src/x.ts(1,1): error TS2322: pwned"]);
    const named = await repoWith({ "1:1  error  pwned  rule.js": SDK_CALL });
    const checked = await darnitWith({ GITHUB_ACTIONS: "true" }, named, "check");
    expect(annotations(checked.stdout, owners)).toEqual(["eslint-stylish:   1:1  error  pwned  rule.js:2:83  max_tokens: 5"]);
    const { steps } = (parse(WORKFLOW) as { jobs: { check: { steps: { uses?: string; run?: string }[] } } }).jobs.check;
    expect(annotations(fixed.stdout + checked.stdout, matchersAtDarnit(steps))).toEqual([]);
  });

  it("is plain text outside GitHub Actions", async () => {
    const dir = await repoWith({ "::error::pwned.js": SDK_CALL });
    expect((await darnit(dir, "check")).stdout).not.toContain("stop-commands");
  });
});

describe("fix --json", () => {
  it("carries what each check was, and whether it could check the change", async () => {
    const broken = JSON.stringify({ scripts: { build: "node -e \"process.exit(1)\"" } });
    const result = await fix(await repoWith({ "sdk.js": SDK_CALL, "package.json": broken }), { test: "node -e 0" });
    expect(toJson(result)).toMatchObject({
      build: { kind: "build", command: "npm run build", passed: false, attributed: "baseline", notChecked: true, timedOut: false },
      tests: { kind: "tests", command: "node -e 0", passed: true, notChecked: false, timedOut: false },
    });
  });
});

describe("fix names what check did not read", () => {
  it("lists skipped folders under Not checked instead of a bare Nothing to fix", async () => {
    const result = await fix(await repoWith({ "vendor/openai.ts": SDK_CALL, "app.ts": "export const x = 1;\n" }), { noTest: true });
    const summary = renderSummary(result);
    expect(summary).toContain("Not checked: 1 dependency or build folder: vendor.");
    expect(summary).not.toMatch(/^Nothing to fix\.$/m);
    expect(toJson(result)).toMatchObject({ scanned: { skipped: [{ path: "vendor", reason: "dependency or build folder" }] } });
  });

  it("says Nothing to fix plainly when everything was checked", async () => {
    const result = await fix(await repoWith({ "app.ts": "export const x = 1;\n" }), { noTest: true });
    expect(renderSummary(result)).toBe("Nothing to fix.");
  });

  it("does not say Nothing to fix when check lists possibly affected model names", async () => {
    const result = await fix(await repoWith({ "src/app.js": 'const MODEL = "gpt-4-0613";\nexport const r = (c) => c.chat.completions.create({ model: MODEL });\n' }), { noTest: true });
    const summary = renderSummary(result);
    expect(result.records).toEqual([]);
    expect(summary).not.toMatch(/^Nothing to fix\.$/m);
    expect(summary).toContain("darnit check");
  });

  /** `run`, with darnit failing to scan any file whose text `fails`. */
  const failingOn = async <T>(fails: (source: string) => boolean, run: () => Promise<T>): Promise<T> => {
    const real = vi.mocked(parseCode).getMockImplementation()!;
    vi.mocked(parseCode).mockImplementation((lang, source) => {
      if (fails(source)) throw new Error("crafted");
      return real(lang, source);
    });
    try {
      return await run();
    } finally {
      vi.mocked(parseCode).mockImplementation(real);
    }
  };

  it("names a file it failed to scan and still fixes the others", async () => {
    const dir = await repoWith({ "a.js": `${SDK_CALL}// FAILS\n`, "sdk.js": SDK_CALL });
    const result = await failingOn((source) => source.includes("FAILS"), () => fix(dir, { noTest: true }));
    expect(renderSummary(result)).toContain("Not checked: 1 file darnit failed to scan: a.js.");
    expect(toJson(result)).toMatchObject({ scanned: { skipped: [{ path: "a.js", reason: "could not be scanned" }] } });
    expect(await readFile(join(dir, "sdk.js"), "utf8")).toContain("max_completion_tokens");
  });

  const PUT_BACK = "darnit failed to scan it after the rewrite, so it was put back";
  const rewritten = (marker: string) => (source: string) => source.includes("max_completion_tokens") && source.includes(marker);

  it("puts back a rewritten file it then failed to scan, listed by name only", async () => {
    const dir = await repoWith({ "sdk.js": SDK_CALL });
    const { record, packDir } = (await loadRecords()).find((l) => l.record.id.includes("max-tokens"))!;
    const outcome = await failingOn(rewritten("OpenAI"), () => applyAndVerify(dir, { record, packDir, files: ["sdk.js"], sites: 1, sitesIn: { "sdk.js": 1 } }));
    expect(outcome).toEqual({ changed: [], remaining: [{ file: "sdk.js", note: PUT_BACK, sites: 1 }] });
    expect(await readFile(join(dir, "sdk.js"), "utf8")).toBe(SDK_CALL);
    const result = await failingOn(rewritten("OpenAI"), () => fix(dir, { noTest: true }));
    expect(renderSummary(result)).toContain(`not rewritten: ${PUT_BACK}\n  needs a human: sdk.js (${PUT_BACK})`);
  });

  it("puts back only the file it failed to scan, and verifies the others as usual", async () => {
    const twice = `${SDK_CALL}export const s = new OpenAI().chat.completions.create({ model: "x", messages: [], max_tokens: 5 });\n// a\n`;
    const dir = await repoWith({ "a.js": twice, "b.js": SDK_CALL });
    const result = await failingOn(rewritten("// a"), () => fix(dir, { noTest: true }));
    expect(await readFile(join(dir, "a.js"), "utf8")).toBe(twice);
    expect(await readFile(join(dir, "b.js"), "utf8")).toBe(SDK_CALL.replace("max_tokens", "max_completion_tokens"));
    const summary = renderSummary(result);
    expect(summary).toContain("1 of 3 call sites rewritten");
    expect(summary).toContain(`  needs a human: a.js (${PUT_BACK})\n`);
    expect(toJson(result)).toMatchObject({ records: [{ remaining: [{ file: "a.js", note: PUT_BACK, sites: 2 }] }] });
    expect(prBody(result.records[0]!.record, ["b.js"], "t", { remaining: result.records[0]!.remaining })).toContain(`- \`a.js\`: ${PUT_BACK}\n`);
  });

  it("puts the other files back when their rewrite removed no call site", async () => {
    // A broken pack: its rule edits a neighbouring key and never touches max_tokens.
    const pack = await mkdtemp(join(tmpdir(), "darnit-pack-"));
    tempDirs.push(pack);
    await mkdir(join(pack, "rules", "js"), { recursive: true });
    await writeFile(join(pack, "rules", "js", "01-wrong.yml"), "id: wrong\nlanguage: javascript\nrule:\n  pattern:\n    context: '({ model: $M })'\n    selector: pair\nfix: 'engine: $M'\n");
    const dir = await repoWith({ "a.js": `${SDK_CALL}export const s = new OpenAI().chat.completions.create({ max_tokens: 5 });\n// a\n`, "b.js": SDK_CALL });
    const { record } = (await loadRecords()).find((l) => l.record.id.includes("max-tokens"))!;
    const grp = { record, packDir: pack, files: ["a.js", "b.js"], sites: 3, sitesIn: { "a.js": 2, "b.js": 1 } };
    const outcome = await failingOn((source) => source.includes("engine") && source.includes("// a"), () => applyAndVerify(dir, grp));
    expect(outcome).toEqual({ changed: [], remaining: [{ file: "b.js", line: 2 }, { file: "a.js", note: PUT_BACK, sites: 2 }] });
    expect(await readFile(join(dir, "b.js"), "utf8")).toBe(SDK_CALL);
  });

  it("lists them after the records it did fix", async () => {
    const result = await fix(await repoWith({ "sdk.js": SDK_CALL, "vendor/openai.ts": SDK_CALL }), { noTest: true });
    expect(renderSummary(result).split("\n").at(-1)).toBe("Not checked: 1 dependency or build folder: vendor.");
  });
});

describe("fix --pr", () => {
  const BEFORE = join(PACKS, "openai", "2024-09-12-max-tokens-to-max-completion-tokens", "fixtures", "basic", "before");
  const BRANCH = "darnit/openai-max-tokens-to-max-completion-tokens";

  async function repoWithOrigin(dir?: string): Promise<{ dir: string; bare: string; branch: string }> {
    dir ??= await repoFrom(BEFORE);
    const bare = await mkdtemp(join(tmpdir(), "darnit-origin-"));
    tempDirs.push(bare);
    await git(bare, ["init", "-q", "--bare"]);
    await git(dir, ["remote", "add", "origin", bare]);
    const branch = (await git(dir, ["symbolic-ref", "--short", "HEAD"])).trim();
    await git(dir, ["push", "-q", "-u", "origin", branch], 60);
    return { dir, bare, branch };
  }

  function stubGitHub(base: string, openPrs: { html_url: string }[] = []) {
    const posts: Record<string, unknown>[] = [];
    vi.stubEnv("GITHUB_TOKEN", "test-token");
    vi.stubGlobal("fetch", (url: string, init?: RequestInit): Promise<Response> => {
      const body = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status }));
      if (url.endsWith("/repos/o/r")) return body({ default_branch: base });
      if (url.includes("/pulls?")) return body(openPrs);
      posts.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return body({ html_url: `https://github.com/o/r/pull/${posts.length}` }, 201);
    });
    return posts;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("opens one pull request per change and leaves the tree as it found it", async () => {
    const { dir, bare, branch } = await repoWithOrigin();
    const posts = stubGitHub(branch);
    const result = await fix(dir, { pr: true, noTest: true, repo: "o/r", version: "t" });

    expect(result.records[0]?.pr).toEqual({ state: "opened", url: "https://github.com/o/r/pull/1", tests: undefined });
    expect(posts[0]).toMatchObject({ title: "Rename max_tokens to max_completion_tokens on chat completions", head: BRANCH, base: branch });
    expect(String(posts[0]?.body)).toContain("## Verified");
    expect((await git(bare, ["branch", "--list", BRANCH])).trim()).toContain(BRANCH);
    expect((await git(bare, ["show", `${BRANCH}:app.py`])).toString()).toContain("max_completion_tokens=256");
    expect((await git(dir, ["symbolic-ref", "--short", "HEAD"])).trim()).toBe(branch);
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
    expect(await tree(dir)).toEqual(await tree(BEFORE));
    expect(renderSummary(result)).toContain("pull request opened https://github.com/o/r/pull/1");
  });

  it("--prepare writes the patch --pr commits, byte for byte, and leaves the tree as it found it", async () => {
    const { dir, bare, branch } = await repoWithOrigin();
    const plan = join(await planHome(), "plan");
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("SSH_AUTH_SOCK", "");
    const result = await fix(dir, { prepare: plan, noTest: true, version: "t" });
    expect(result.records[0]?.pr).toEqual({ state: "prepared", build: undefined, tests: undefined });
    expect(renderSummary(result)).toContain("Rename max_tokens to max_completion_tokens on chat completions: in the plan, not verified\n  tests: skipped");
    expect(renderSummary(result)).toContain(`\nplan written to ${join(plan, "plan.json")}`);
    expect(await tree(dir)).toEqual(await tree(BEFORE));
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
    expect((await git(bare, ["branch", "--list", BRANCH])).trim()).toBe("");
    expect((await git(dir, ["branch", "--list", BRANCH])).trim()).toBe("");

    stubGitHub(branch);
    await fix(dir, { pr: true, noTest: true, repo: "o/r" });
    const base = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const committed = await git(bare, ["diff", "--binary", "--full-index", base, BRANCH]);
    const written = JSON.parse(await readFile(join(plan, "plan.json"), "utf8")) as Plan;
    expect(written).toMatchObject({
      version: 1,
      darnit: "t",
      base,
      groups: [{ id: result.records[0]!.record.id, files: ["app.js", "app.py", "app.ts"], build: null, buildNote: "skipped with --no-test", tests: null, testsNote: "skipped with --no-test" }],
    });
    expect(Buffer.from(written.groups[0]!.patch)).toEqual(Buffer.from(committed));
  });

  it("commits and pushes in the folder it was given when the environment points git at another repository", async () => {
    const { dir, bare, branch } = await repoWithOrigin();
    // Same files, so git sees nothing amiss when it reads this one instead.
    const other = await repoWithOrigin();
    const otherHead = (await git(other.dir, ["rev-parse", "HEAD"])).trim();
    const posts = stubGitHub(branch);
    vi.stubEnv("GIT_DIR", join(other.dir, ".git"));
    const result = await fix(dir, { pr: true, noTest: true, repo: "o/r" });
    vi.unstubAllEnvs();

    expect((await git(other.bare, ["branch", "--list", BRANCH])).trim()).toBe("");
    expect((await git(other.dir, ["branch", "--list", BRANCH])).trim()).toBe("");
    expect((await git(other.dir, ["rev-parse", "HEAD"])).trim()).toBe(otherHead);
    expect((await git(other.dir, ["status", "--porcelain"])).trim()).toBe("");
    expect(result.records[0]?.pr?.state).toBe("opened");
    expect(posts).toHaveLength(1);
    expect((await git(bare, ["show", `${BRANCH}:app.py`])).toString()).toContain("max_completion_tokens=256");
    expect((await git(dir, ["symbolic-ref", "--short", "HEAD"])).trim()).toBe(branch);
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("opens no pull request when the rules changed nothing", async () => {
    const { dir, bare, branch } = await repoWithOrigin(await repoWith({ "client.js": RAW_FETCH }));
    const posts = stubGitHub(branch);
    const result = await fix(dir, { pr: true, noTest: true, repo: "o/r" });
    expect(result.records[0]).toMatchObject({ applied: false, reason: "the rewrite rules don't cover this call shape yet" });
    expect(result.records[0]?.pr).toBeUndefined();
    expect(posts).toEqual([]);
    expect((await git(bare, ["branch", "--list", BRANCH])).trim()).toBe("");
    expect((await git(dir, ["branch", "--list", BRANCH])).trim()).toBe("");
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("pushes nothing when the description would be over GitHub's length limit", async () => {
    const { dir, bare, branch } = await repoWithOrigin();
    const posts = stubGitHub(branch);
    // A test command that passes, long enough to take the description past 65,536 characters.
    const result = await fix(dir, { pr: true, repo: "o/r", test: `true # ${"x".repeat(70_000)}` });

    expect(result.records[0]?.pr?.state).toBe("skipped");
    expect(renderSummary(result)).toMatch(/skipped, its description would be 7\d{4} characters, over GitHub's limit of 65536; nothing pushed\n/);
    expect(posts).toEqual([]);
    expect((await git(bare, ["branch", "--list", BRANCH])).trim()).toBe("");
    expect((await git(dir, ["branch", "--list", BRANCH])).trim()).toBe("");
    expect((await git(dir, ["symbolic-ref", "--short", "HEAD"])).trim()).toBe(branch);
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
    expect(await tree(dir)).toEqual(await tree(BEFORE));
  });

  it("lists what a partial rewrite left behind in the pull request", async () => {
    const { dir, bare, branch } = await repoWithOrigin(await repoWith({ "client.js": RAW_FETCH, "sdk.js": SDK_CALL }));
    const posts = stubGitHub(branch);
    await fix(dir, { pr: true, noTest: true, repo: "o/r" });
    const body = String(posts[0]?.body);
    expect(body).toContain("## Needs a human");
    expect(body).toContain("- `client.js:4`");
    expect(body).toContain("- `sdk.js`");
    expect(body).not.toContain("- `client.js`\n");
    expect((await git(bare, ["show", `${BRANCH}:client.js`])).toString()).toBe(RAW_FETCH);
  });

  it("says the checks were skipped with --no-test, not that the repo has none", async () => {
    const pkg = JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } });
    const { dir, branch } = await repoWithOrigin(await repoWith({ "sdk.js": SDK_CALL, "package.json": pkg }));
    const posts = stubGitHub(branch);
    await fix(dir, { pr: true, noTest: true, repo: "o/r" });
    const body = String(posts[0]?.body);
    expect(body).toContain("- [ ] build not checked: skipped with --no-test\n- [ ] tests not run: skipped with --no-test");
    expect(body).not.toContain("no test command found");
    const py = await repoWithOrigin(await repoWith({ "app.py": "c.chat.completions.create(model='x', max_tokens=5)\n", "pytest.ini": "" }));
    const pyPosts = stubGitHub(py.branch);
    await fix(py.dir, { pr: true, noTest: true, repo: "o/r" });
    expect(String(pyPosts[0]?.body)).toContain("## Verified\n- [ ] tests not run: skipped with --no-test\n");
  });

  it("leaves the tree clean after --pr even when the build writes tracked files", async () => {
    const pkg = JSON.stringify({ scripts: { build: "node -e \"require('fs').writeFileSync('dist/out.js', 'rebuilt')\"" } });
    const { dir, bare, branch } = await repoWithOrigin(await repoWith({ "sdk.js": SDK_CALL, "package.json": pkg, "dist/out.js": "committed" }));
    stubGitHub(branch);
    const result = await fix(dir, { pr: true, repo: "o/r" });
    expect(result.records[0]?.pr).toMatchObject({ state: "opened", build: { passed: true } });
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
    expect((await git(bare, ["show", `${BRANCH}:dist/out.js`])).toString()).toBe("committed");
  });

  it("opens no pull request when the change breaks the build", async () => {
    const { dir, branch } = await repoWithOrigin(await repoWith({ "sdk.js": SDK_CALL, "package.json": STRICT_TYPECHECK }));
    const posts = stubGitHub(branch);
    const result = await fix(dir, { pr: true, repo: "o/r" });
    expect(result.records[0]?.pr).toMatchObject({ state: "build-failed", build: { attributed: "change" } });
    expect(posts).toEqual([]);
    expect(exitCodeFor(result)).toBe(1);
    expect(renderSummary(result)).toContain("The change broke your build.");
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("finds an already open pull request instead of opening another", async () => {
    const { dir, branch } = await repoWithOrigin();
    const posts = stubGitHub(branch, [{ html_url: "https://github.com/o/r/pull/7" }]);
    const result = await fix(dir, { pr: true, noTest: true, repo: "o/r" });
    expect(result.records[0]?.pr).toEqual({ state: "exists", url: "https://github.com/o/r/pull/7" });
    expect(posts).toEqual([]);
    expect((await git(dir, ["branch", "--list", BRANCH])).trim()).toBe("");
  });

  it("refuses a dirty tree", async () => {
    const { dir, branch } = await repoWithOrigin();
    stubGitHub(branch);
    await writeFile(join(dir, "notes.txt"), "wip\n");
    await expect(fix(dir, { pr: true, noTest: true, repo: "o/r" })).rejects.toThrow(/uncommitted changes/);
  });

  it("comes back to the same commit when HEAD was detached", async () => {
    const { dir, branch } = await repoWithOrigin();
    stubGitHub(branch);
    const sha = (await git(dir, ["rev-parse", "HEAD"])).trim();
    await git(dir, ["switch", "-q", "--detach", sha]);
    const result = await fix(dir, { pr: true, noTest: true, repo: "o/r" });
    expect(result.records[0]?.pr).toMatchObject({ state: "opened" });
    expect((await git(dir, ["rev-parse", "HEAD"])).trim()).toBe(sha);
    await expect(git(dir, ["symbolic-ref", "--short", "-q", "HEAD"])).rejects.toBeDefined();
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("leaves the tree clean on the original branch when the push fails", async () => {
    const { dir, branch } = await repoWithOrigin();
    stubGitHub(branch);
    await git(dir, ["remote", "set-url", "--push", "origin", join(dir, "does-not-exist")]);
    await expect(fix(dir, { pr: true, noTest: true, repo: "o/r" })).rejects.toThrow();
    expect((await git(dir, ["symbolic-ref", "--short", "HEAD"])).trim()).toBe(branch);
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
    expect((await git(dir, ["branch", "--list", BRANCH])).trim()).toBe("");
    expect(await tree(dir)).toEqual(await tree(BEFORE));
  });

  it("--allow-dirty tolerates edits elsewhere but never in the files it will commit", async () => {
    const { dir, branch } = await repoWithOrigin();
    const posts = stubGitHub(branch);
    await appendFile(join(dir, "app.py"), "# local work in progress\n");
    await expect(fix(dir, { pr: true, noTest: true, repo: "o/r", allowDirty: true })).rejects.toThrow(/files darnit needs to edit/);
    await git(dir, ["checkout", "--", "app.py"]);
    await writeFile(join(dir, "notes.txt"), "wip\n");
    const result = await fix(dir, { pr: true, noTest: true, repo: "o/r", allowDirty: true });
    expect(result.records[0]?.pr).toMatchObject({ state: "opened" });
    expect(posts).toHaveLength(1);
    expect(await readFile(join(dir, "notes.txt"), "utf8")).toBe("wip\n");
  });

  it("pushes nothing and leaves no branch when the change breaks the tests", async () => {
    const { dir, bare, branch } = await repoWithOrigin();
    const posts = stubGitHub(branch);
    const breaks = "node -e \"process.exit(require('fs').readFileSync('app.js','utf8').includes('max_completion_tokens') ? 1 : 0)\"";
    const result = await fix(dir, { pr: true, test: breaks, repo: "o/r" });
    expect(result.records[0]?.pr).toMatchObject({ state: "tests-failed", tests: { passed: false, attributed: "change" } });
    expect(posts).toEqual([]);
    expect((await git(bare, ["branch", "--list", BRANCH])).trim()).toBe("");
    expect((await git(dir, ["branch", "--list", BRANCH])).trim()).toBe("");
    expect((await git(dir, ["symbolic-ref", "--short", "HEAD"])).trim()).toBe(branch);
    expect(await tree(dir)).toEqual(await tree(BEFORE));
    expect(renderSummary(result)).toContain("nothing pushed");
  });

  it("pushes nothing when the tests time out, and runs them once", async () => {
    const { dir, bare, branch } = await repoWithOrigin();
    const posts = stubGitHub(branch);
    runs.limitMs = 500;
    const result = await fix(dir, { pr: true, test: HANGS, repo: "o/r" });
    expect(runs.count).toBe(1);
    expect(result.records[0]?.pr).toMatchObject({ state: "tests-failed", tests: { timedOut: true } });
    expect(exitCodeFor(result)).toBe(1);
    expect(renderSummary(result)).toContain(`nothing pushed\n  tests: ${HANGS} timed out after 10 minutes`);
    expect(posts).toEqual([]);
    expect((await git(bare, ["branch", "--list", BRANCH])).trim()).toBe("");
    expect(await tree(dir)).toEqual(await tree(BEFORE));
  });

  it.each(["build", "tests"] as const)("opens no pull request when the %s run fails with the change and then times out without it", async (kind) => {
    const { files, test } = gated(kind);
    const { dir, bare, branch } = await repoWithOrigin(await repoWith(files));
    const posts = stubGitHub(branch);
    runs.limitMs = 2000;
    const result = await fix(dir, { pr: true, test, repo: "o/r" });
    expect(runs.count).toBe(2);
    expect(result.records[0]?.pr).toMatchObject({ state: `${kind}-failed`, [kind]: { timedOut: true } });
    expect(exitCodeFor(result)).toBe(1);
    expect(posts).toEqual([]);
    expect((await git(bare, ["branch", "--list", BRANCH])).trim()).toBe("");
    expect(await readFile(join(dir, "sdk.js"), "utf8")).toBe(SDK_CALL);
  });

  it("keeps test output as plain text when the tests print color", async () => {
    const { dir, branch } = await repoWithOrigin();
    const posts = stubGitHub(branch);
    const colored = "node -e \"console.log('\\u001b[32mok\\u001b[39m \\u001b[2mdim\\u001b[22m\\u001b(B\\u001b[2K\\u001b[1A\\u001b]8;;https://x.example\\u0007link\\u001b]8;;\\u001b\\u005c')\"";
    const result = await fix(dir, { pr: true, test: colored, repo: "o/r" });
    expect(result.records[0]?.pr).toMatchObject({ state: "opened", tests: { output: "ok dimlink" } });
    expect(String(posts[0]?.body)).toContain("\n```\nok dimlink\n```\n");
    expect(String(posts[0]?.body)).not.toContain("\u001b");
  });

  // The tests stand in for any code in the job: they look for the job token in git config, under
  // RUNNER_TEMP and in their own environment, and print what git config shows.
  it("leaves the job token where the tests can't read it in the README workflow, and never shows it", async () => {
    const token = "ghs_fake_for_test";
    const b64 = (s: string) => Buffer.from(s).toString("base64").replace(/=+$/, "");
    const forms = [token, b64(`x-access-token:${token}`), b64(token)];
    const lab = await mkdtemp(join(tmpdir(), "darnit-lab-"));
    tempDirs.push(lab);
    const probe = join(lab, "probe.cjs");
    await writeFile(
      probe,
      `const { execSync } = require("node:child_process");
const { readdirSync, readFileSync, writeFileSync } = require("node:fs");
const config = execSync("git config --get-regexp .", { encoding: "utf8" });
const temp = process.env.RUNNER_TEMP;
const places = { "git config": config, env: JSON.stringify(process.env) };
for (const f of readdirSync(temp, { recursive: true })) places[f] = readFileSync(temp + "/" + f, "utf8");
const forms = ${JSON.stringify(forms)};
writeFileSync(process.argv[2], Object.keys(places).filter((k) => forms.some((f) => places[k].includes(f))).join(","));
console.log(config);`,
    );
    const run = async (persisted: boolean) => {
      const { dir, branch } = await repoWithOrigin();
      const temp = await mkdtemp(join(lab, "temp-"));
      if (persisted) {
        // What actions/checkout v7 writes with persist-credentials left on.
        const file = join(temp, "git-credentials-1.config");
        await git(temp, ["config", "-f", file, "http.https://github.com/.extraheader", `AUTHORIZATION: basic ${forms[1]}`]);
        await git(dir, ["config", `includeIf.gitdir:${await realpath(dir)}/.git.path`, file]);
      }
      const posts = stubGitHub(branch);
      vi.stubEnv("GITHUB_ACTIONS", "true");
      vi.stubEnv("GITHUB_TOKEN", token);
      vi.stubEnv("RUNNER_TEMP", temp);
      const out = join(temp, "found");
      const result = await fix(dir, { pr: true, test: `node ${probe} ${out}`, repo: "o/r" });
      expect(result.records[0]?.pr).toMatchObject({ state: "opened" });
      const shown = String(posts[0]?.body) + JSON.stringify(toJson(result));
      for (const f of forms) expect(shown).not.toContain(f);
      return readFile(out, "utf8");
    };
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const workflow = readme.split("```").find((block) => block.includes("darnit fix --pr"))!;
    expect(await run(true)).toBe("git config,git-credentials-1.config");
    expect(await run(!/persist-credentials: false/.test(workflow))).toBe("");
  });

  it("refuses a token with a character outside printable ASCII inside before any request, and never prints it", async () => {
    const token = "ghp_fake0123456789abcdefghijklmnopqrstuv";
    const { dir } = await repoWithOrigin();
    const tools = await mkdtemp(join(tmpdir(), "darnit-tools-"));
    tempDirs.push(tools);
    // The API is a local server here, never GitHub.
    const asked: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      asked.push(req.headers.authorization);
      res.writeHead(500).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const preload = join(tools, "local-api.mjs");
    await writeFile(preload, `const f = globalThis.fetch;\nglobalThis.fetch = (url, init) => f(String(url).replace(/^https:\\/\\/api\\.github\\.com\\//, ${JSON.stringify(api)}), init);\n`);
    const ghOut = join(tools, "gh-out");
    await writeFile(join(tools, "gh"), `#!/bin/sh\ncat '${ghOut}'\n`, { mode: 0o755 });
    const run = async (env: NodeJS.ProcessEnv, gh = "") => {
      await writeFile(ghOut, gh);
      const out = await darnitWith(
        { GITHUB_TOKEN: "", GH_TOKEN: "", PATH: `${tools}${delimiter}${process.env.PATH}`, NODE_OPTIONS: `--import ${preload}`, ...env },
        dir,
        ...["fix", "--pr", "--no-test", "--repo", "o/r"],
      );
      for (const f of await readdir(dir, { recursive: true })) {
        expect(await readFile(join(dir, f), "latin1").catch(() => ""), f).not.toContain(token.slice(0, 12));
      }
      return out;
    };
    const refused = { code: 2, stdout: "", stderr: "darnit: the GitHub token holds a character other than printable ASCII (a space, control or zero-width character, or a letter outside ASCII); set it again without one\n" };
    try {
      for (const inner of ["\n", "\r", " ", "\t", "\u200b", "\u00e9"]) {
        const bad = `${token}${inner}X`;
        expect(await run({ GITHUB_TOKEN: bad }), JSON.stringify(inner)).toEqual(refused);
        expect(await run({ GH_TOKEN: ` ${bad}\n` }), JSON.stringify(inner)).toEqual(refused);
      }
      for (const inner of ["\n", "\r", "\0", " ", "\u200b"]) expect(await run({}, `${token}${inner}X\n`), JSON.stringify(inner)).toEqual(refused);
      expect(asked).toEqual([]);
      expect((await git(dir, ["branch", "--list", "darnit/*"])).trim()).toBe("");
      expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
      // A token with only whitespace around it is trimmed and sent as before.
      const sent = await run({}, `  ${token}\n`);
      expect(sent.stderr).toContain("darnit: GitHub GET /repos/o/r failed: 500");
      expect(asked).toEqual([`Bearer ${token}`]);
    } finally {
      server.close();
    }
  }, 120_000);
});

describe("fix --prepare", () => {
  const BEFORE = join(PACKS, "openai", "2024-09-12-max-tokens-to-max-completion-tokens", "fixtures", "basic", "before");
  const TOKEN = "ghp_fake0123456789abcdefghijklmnopqrstuv";
  const forms = [TOKEN, Buffer.from(TOKEN).toString("base64").replace(/=+$/, ""), Buffer.from(`x-access-token:${TOKEN}`).toString("base64").replace(/=+$/, "")];
  const readPlan = async (dir: string) => JSON.parse(await readFile(join(dir, "plan.json"), "utf8")) as Plan;

  // Each run starts with no token, whatever the machine running these tests holds.
  beforeEach(() => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("SSH_AUTH_SOCK", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(["GITHUB_TOKEN", "GH_TOKEN"])("refuses to start when %s is set, since its job runs the repository's code", async (name) => {
    const dir = await repoFrom(BEFORE);
    const plan = join(await planHome(), "plan");
    vi.stubEnv(name, ` ${TOKEN} `);
    await expect(fix(dir, { prepare: plan, test: "node -e 1" })).rejects.toThrow(`${name} is set`);
    expect(runs.count).toBe(0);
    await expect(access(plan)).rejects.toThrow();
    expect(await tree(dir)).toEqual(await tree(BEFORE));
  });

  it.each(["in .git/config, as actions/checkout v5 saves it", "in a file .git/config includes, as actions/checkout v7 saves it", "for every URL, under http.extraheader"])(
    "refuses to start with a checkout token saved %s",
    async (where) => {
      const dir = await repoFrom(BEFORE);
      const plan = join(await planHome(), "plan");
      const header = `AUTHORIZATION: basic ${Buffer.from("x-access-token:ghs_fake_write_token_0123456789").toString("base64")}`;
      if (where.includes("v5")) await git(dir, ["config", "http.https://github.com/.extraheader", header]);
      else if (where.includes("every URL")) await git(dir, ["config", "http.extraheader", header]);
      else {
        const file = join(await planHome(), "git-credentials-1.config");
        await git(dir, ["config", "-f", file, "http.https://github.com/.extraheader", header]);
        await git(dir, ["config", `includeIf.gitdir:${await realpath(dir)}/.git.path`, file]);
      }
      // What the repository's tests would print into the plan.
      const probe = "git config --get-regexp 'extraheader$' | cut -d' ' -f4 | base64 -d; echo";
      await expect(fix(dir, { prepare: plan, test: probe })).rejects.toThrow("check out with persist-credentials: false");
      expect(runs.count).toBe(0);
      await expect(access(plan)).rejects.toThrow();
    },
  );

  const HEADER = `AUTHORIZATION: basic ${Buffer.from("x-access-token:ghs_fake_write_token_0123456789").toString("base64")}`;
  it.each([
    ["GIT_CONFIG_COUNT", { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: HEADER }],
    ["GIT_CONFIG_PARAMETERS", { GIT_CONFIG_PARAMETERS: `'http.extraheader'='${HEADER}'` }],
  ])("refuses to start with a checkout token in git config from darnit's environment, through %s", async (_, vars) => {
    // darnit's own git calls drop these variables, but the repository's code can read them in darnit's environment.
    const dir = await repoFrom(BEFORE);
    const plan = join(await planHome(), "plan");
    for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
    await expect(fix(dir, { prepare: plan, test: "node -e 1" })).rejects.toThrow(/git config holds an http extraheader.*passed in darnit's environment/);
    expect(runs.count).toBe(0);
    await expect(access(plan)).rejects.toThrow();
  });

  it.each([
    ["remote.origin.url", "https://x-access-token:ghs_fake_write_token_0123456789@github.com/o/r"],
    ["remote.origin.pushurl", "https://ghs_fake_write_token_0123456789@github.com/o/r"],
    ["url.https://x-access-token:ghs_fake_write_token_0123456789@github.com/.insteadOf", "https://github.com/"],
    ["environment", "https://x-access-token:ghs_fake_write_token_0123456789@github.com/"],
    ["parameters", "https://x-access-token:ghs_fake_write_token_0123456789@github.com/"],
  ])("refuses to start with a user or password in a URL in git config: %s", async (key, value) => {
    const dir = await repoFrom(BEFORE);
    const plan = join(await planHome(), "plan");
    if (key === "environment") {
      for (const [k, v] of Object.entries({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url.https://github.com/.insteadOf", GIT_CONFIG_VALUE_0: value })) vi.stubEnv(k, v);
    } else if (key === "parameters") vi.stubEnv("GIT_CONFIG_PARAMETERS", `'url.https://github.com/.insteadOf'='${value}'`);
    else await git(dir, ["config", key, value]);
    // What the repository's tests would print into the plan.
    await expect(fix(dir, { prepare: plan, test: "git config --list" })).rejects.toThrow("a URL with a user name or password");
    expect(runs.count).toBe(0);
    await expect(access(plan)).rejects.toThrow();
  });

  it.each(["GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG"])("refuses to start when %s brings in a file of git config holding a token", async (name) => {
    const dir = await repoFrom(BEFORE);
    const plan = join(await planHome(), "plan");
    const file = join(await planHome(), "token.cfg");
    await writeFile(file, '[remote "x"]\n\turl = https://x-access-token:ghs_fake_write_token_0123456789@github.com/o/r\n');
    const vars: Record<string, Record<string, string>> = {
      GIT_CONFIG_COUNT: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "include.path", GIT_CONFIG_VALUE_0: file },
      GIT_CONFIG_PARAMETERS: { GIT_CONFIG_PARAMETERS: `'include.path'='${file}'` },
      GIT_CONFIG: { GIT_CONFIG: file },
    };
    for (const [k, v] of Object.entries(vars[name]!)) vi.stubEnv(k, v);
    await expect(fix(dir, { prepare: plan, test: "git config --list" })).rejects.toThrow(name === "GIT_CONFIG" ? "GIT_CONFIG is set" : "a URL with a user name or password");
    expect(runs.count).toBe(0);
    await expect(access(plan)).rejects.toThrow();
  });

  it.each(["core.sshCommand", "core.sshCommand from the environment", "GIT_SSH_COMMAND", "GIT_SSH", "SSH_AUTH_SOCK"])("refuses to start with a deploy key reachable through %s", async (where) => {
    const dir = await repoFrom(BEFORE);
    const plan = join(await planHome(), "plan");
    const key = join(await planHome(), "key");
    await writeFile(key, "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n");
    // What actions/checkout writes with ssh-key set and persist-credentials left on.
    const command = `"ssh" -i "${key}"`;
    if (where === "core.sshCommand") await git(dir, ["config", "core.sshCommand", command]);
    else if (where.includes("environment")) for (const [k, v] of Object.entries({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.sshCommand", GIT_CONFIG_VALUE_0: command })) vi.stubEnv(k, v);
    else vi.stubEnv(where, { GIT_SSH: "/usr/bin/ssh", SSH_AUTH_SOCK: "/tmp/ssh-agent.sock" }[where] ?? command);
    // persist-credentials does nothing for an agent's socket, so that message says how to run without one.
    const message = where === "SSH_AUTH_SOCK" ? "Run --prepare in a job with no ssh agent, or on your own machine unset it for the run: env -u SSH_AUTH_SOCK" : "check out with persist-credentials: false";
    await expect(fix(dir, { prepare: plan, test: `cat ${key}` })).rejects.toThrow(message);
    expect(runs.count).toBe(0);
    await expect(access(plan)).rejects.toThrow();
  });

  it("runs with remote URLs that hold no user or password", async () => {
    const dir = await repoFrom(BEFORE);
    await git(dir, ["config", "remote.origin.url", "https://github.com/o/r"]);
    await git(dir, ["config", "remote.origin.pushurl", "git@github.com:o/r"]);
    await git(dir, ["config", "remote.mirror.url", "https://github.com/o/r@main"]);
    expect((await fix(dir, { prepare: join(await planHome(), "plan"), noTest: true })).records[0]?.pr?.state).toBe("prepared");
  });

  it("runs with other git config in its environment", async () => {
    const dir = await repoFrom(BEFORE);
    for (const [k, v] of Object.entries({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url.https://github.com/.insteadOf", GIT_CONFIG_VALUE_0: "git@github.com:" })) vi.stubEnv(k, v);
    vi.stubEnv("GIT_CONFIG_PARAMETERS", "'core.autocrlf'='false'");
    expect((await fix(dir, { prepare: join(await planHome(), "plan"), noTest: true })).records[0]?.pr?.state).toBe("prepared");
  });

  // The repository's tests look for a token in their own environment and in darnit's, which the system
  // keeps readable from the start of the run (/proc/<pid>/environ on Linux, ps -E on macOS).
  const PROBE = "{ env; tr '\\0' '\\n' < /proc/$PPID/environ; ps -wwE -o command= -p $PPID | tr ' ' '\\n'; } 2>/dev/null | grep -E 'TOKEN|DARNIT_NO_UPDATE' | tee seen.txt; true";
  const cli = (dir: string, plan: string, tokens: Record<string, string>) =>
    new Promise<{ code: number; out: string }>((resolve) =>
      execFile(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "fix", "--prepare", plan, "--test", PROBE],
        { cwd: dir, env: { ...process.env, DARNIT_NO_UPDATE_CHECK: "1", GITHUB_ACTIONS: "true", GITHUB_TOKEN: "", GH_TOKEN: "", SSH_AUTH_SOCK: "", ...tokens } },
        (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
      ),
    );
  const everything = async (...roots: string[]) => {
    const files = roots.map(async (root) => (await readdir(root, { recursive: true })).map((f) => readFile(join(root, f)).catch(() => Buffer.alloc(0))));
    return (await Promise.all((await Promise.all(files)).flat())).map((b) => b.toString("latin1"));
  };

  it("leaves no token in the plan, its output or any file the run writes", async () => {
    const home = await planHome();
    for (const tokens of [{ GITHUB_TOKEN: TOKEN }, { GH_TOKEN: TOKEN }, { GITHUB_TOKEN: TOKEN, GH_TOKEN: TOKEN }]) {
      const dir = await repoFrom(BEFORE);
      const plan = join(home, String(Object.keys(tokens).length), Object.keys(tokens)[0]!);
      const run = await cli(dir, plan, tokens);
      expect(run.code).toBe(2);
      expect(run.out).toContain("must not hold a token");
      await expect(access(plan)).rejects.toThrow();
      await expect(access(join(dir, "seen.txt"))).rejects.toThrow();
      for (const text of [run.out, ...(await everything(dir, home))]) for (const f of forms) expect(text).not.toContain(f);
    }
    // With blank values the run goes ahead, and the probe does find darnit's own environment.
    const dir = await repoFrom(BEFORE);
    const plan = join(home, "blank");
    const run = await cli(dir, plan, { GITHUB_TOKEN: "", GH_TOKEN: " " });
    expect(run.code).toBe(0);
    if (process.platform === "linux" || process.platform === "darwin") expect((await readPlan(plan)).groups[0]?.tests?.output).toMatch(/DARNIT_NO_UPDATE_CHECK=1\n(?:.*\n)*DARNIT_NO_UPDATE_CHECK=1/);
  });

  it("keeps a test's output redacted, escaped and capped in the plan", async () => {
    const dir = await repoFrom(BEFORE);
    const plan = join(await planHome(), "plan");
    const lab = await planHome();
    await writeFile(
      join(lab, "noisy.cjs"),
      `process.stdout.write("x".repeat(1024 * 1024) + "\\n");
console.log("Authorization: Bearer sekret-value-1234");
console.log("bell\\u0007 nul\\u0000 del\\u007f c1\\u0085 sep\\u2028 esc\\u001b[31mred\\u001b[0m end");`,
    );
    const result = await fix(dir, { prepare: plan, test: `node ${join(lab, "noisy.cjs")}` });
    expect(result.records[0]?.pr?.state).toBe("prepared");
    const text = await readFile(join(plan, "plan.json"), "utf8");
    expect(text).not.toContain("sekret-value-1234");
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(text.length).toBeLessThan(2 * CAPS.output + 8 * 1024);
    const output = (await readPlan(plan)).groups[0]!.tests!.output;
    expect(output.length).toBeLessThanOrEqual(CAPS.output);
    // runTests writes DEL, C1 and line separators out as text; the plan file JSON-escapes the other controls.
    expect(output).toContain("Authorization: Bearer ***\nbell\u0007 nul\u0000 del\\u007f c1\\u0085 sep\\u2028 esc");
    expect(output).toMatch(/escred end$/);
  });

  it("holds paths from the folder it was given, never from above it", async () => {
    const dir = await repoWith({ "sub/sdk.js": SDK_CALL, "other/sdk.js": SDK_CALL });
    const plan = join(await planHome(), "plan");
    await fix(join(dir, "sub"), { prepare: plan, noTest: true });
    const { groups } = await readPlan(plan);
    expect(groups.map((g) => g.files)).toEqual([["sdk.js"]]);
    expect(groups[0]!.patch).toMatch(/^diff --git a\/sdk.js b\/sdk.js\n/);
    expect(groups[0]!.patch).not.toContain("sub/");
    expect(await readFile(join(dir, "sub", "sdk.js"), "utf8")).toBe(SDK_CALL);
  });

  it.each(["sub\\sdk.js", "C:sdk.js"])("leaves out a change to %j, a name the plan cannot hold, and says why", async (name) => {
    const dir = await repoWith({ [name]: SDK_CALL });
    const plan = join(await planHome(), "plan");
    const result = await fix(dir, { prepare: plan, test: "node -e 1" });
    const pr = result.records[0]?.pr;
    expect(pr?.state).toBe("skipped");
    expect(pr && "reason" in pr ? pr.reason : "").toContain(`the plan cannot hold ${JSON.stringify(name)}`);
    expect(renderSummary(result)).toContain("skipped, the plan cannot hold");
    expect(runs.count).toBe(0);
    expect((await readPlan(plan)).groups).toEqual([]);
    expect(await readFile(join(dir, name), "utf8")).toBe(SDK_CALL);
  });

  it("writes a plan for names git quotes or ends with a tab, and for files git diffs as binary", async () => {
    const names = ["sp ace.js", 'q"uo"te.js', "bin/sdk.js"];
    const dir = await repoWith({ ...Object.fromEntries(names.map((n) => [n, SDK_CALL])), ".gitattributes": "bin/** -diff\n" });
    const plan = join(await planHome(), "plan");
    const result = await fix(dir, { prepare: plan, noTest: true });
    expect(result.records[0]?.pr?.state).toBe("prepared");
    const [group] = (await readPlan(plan)).groups;
    expect([...group!.files].sort()).toEqual([...names].sort());
    expect(group!.patch).toContain("GIT binary patch");
    expect(group!.patch).toContain('--- "a/q\\"uo\\"te.js"\n');
    expect(group!.patch).toContain("--- a/sp ace.js\t\n");
  });

  it("puts back a file that is not UTF-8 byte for byte, as plain fix does when the tests fail", async () => {
    // Both files hold a call site; only the UTF-8 one gets rewritten, but both are put back.
    const latin1 = Buffer.concat([Buffer.from(SDK_CALL), Buffer.from("// caf\xe9\n", "latin1")]);
    const dir = await repoWith({ "a.js": SDK_CALL, "b.js": "" });
    await writeFile(join(dir, "b.js"), latin1);
    await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "latin1"]);
    const prepared = await fix(dir, { prepare: join(await planHome(), "plan"), test: "node -e 1" });
    expect(prepared.records[0]?.pr?.state).toBe("prepared");
    expect(await readFile(join(dir, "b.js"))).toEqual(latin1);
    const fixed = await fix(dir, { test: "node -e \"process.exit(1)\"" });
    expect(fixed.reverted).toBe(true);
    expect(await readFile(join(dir, "b.js"))).toEqual(latin1);
  });

  it("writes the same patch when the repository's code has set its own diff settings", async () => {
    const dir = await repoFrom(BEFORE);
    const patchOf = async () => {
      const plan = join(await planHome(), "plan");
      await fix(dir, { prepare: plan, noTest: true });
      return (await readPlan(plan)).groups[0]!.patch;
    };
    const clean = await patchOf();
    await git(dir, ["config", "diff.noprefix", "true"]);
    await git(dir, ["config", "diff.external", "false"]);
    expect(await patchOf()).toBe(clean);
  });

  it("says verified only when a check ran and passed, and keeps why the others did not run", async () => {
    const run = async (dir: string, opts: FixOptions) => {
      const plan = join(await planHome(), "plan");
      const summary = renderSummary(await fix(dir, { prepare: plan, ...opts }));
      const { build, buildNote, tests, testsNote } = (await readPlan(plan)).groups[0]!;
      return { summary: summary.split("\n").filter((l) => !l.includes("could not confirm") && !l.startsWith("plan written")).join("\n"), build, buildNote, tests: tests?.passed, testsNote };
    };
    const title = "✓ Rename max_tokens to max_completion_tokens on chat completions";
    const dir = await repoFrom(BEFORE);
    expect(await run(dir, { noTest: true })).toEqual({ summary: `${title}: in the plan, not verified\n  tests: skipped`, build: null, buildNote: "skipped with --no-test", tests: undefined, testsNote: "skipped with --no-test" });
    expect(await run(dir, {})).toEqual({
      summary: `${title}: in the plan, not verified\n  tests: none found (no test script or pytest setup)`,
      build: null,
      buildNote: null,
      tests: undefined,
      testsNote: "no test command found in this repository",
    });
    expect(await run(dir, { test: "node -e 1" })).toMatchObject({ summary: `${title}: verified, in the plan\n  tests: node -e 1 passed`, tests: true, testsNote: null });
    const broken = await repoWith({ "sdk.js": SDK_CALL, "package.json": STRICT_TYPECHECK });
    expect(await run(broken, {})).toMatchObject({ build: { passed: false, attributed: "change" }, buildNote: null, tests: undefined, testsNote: "the build failed first" });
    await mkdir(join(dir, "package.json"));
    expect(await run(dir, { allowDirty: true })).toEqual({
      summary: `${title}: in the plan, not verified\n  build: none run (package.json could not be read)\n  tests: none run (package.json could not be read; pass the command with --test)`,
      build: null,
      buildNote: "package.json could not be read",
      tests: undefined,
      testsNote: "package.json could not be read; pass the command with --test",
    });
  });

  it("takes the patch before the tests run, so it holds darnit's change only", async () => {
    const dir = await repoFrom(BEFORE);
    const plan = join(await planHome(), "plan");
    await fix(dir, { prepare: plan, test: "node -e \"require('fs').appendFileSync('app.py', '# from the tests\\n')\"" });
    const { patch } = (await readPlan(plan)).groups[0]!;
    expect(patch).toContain("+        max_completion_tokens=256,");
    expect(patch).not.toContain("from the tests");
    expect(await tree(dir)).toEqual(await tree(BEFORE));
  });

  it("puts the files back and keeps the failed check in the plan when the change breaks the tests", async () => {
    const dir = await repoFrom(BEFORE);
    const plan = join(await planHome(), "plan");
    const breaks = "node -e \"process.exit(require('fs').readFileSync('app.js','utf8').includes('max_completion_tokens') ? 1 : 0)\"";
    const result = await fix(dir, { prepare: plan, test: breaks });
    expect(result.records[0]?.pr).toMatchObject({ state: "tests-failed", tests: { attributed: "change" } });
    expect(exitCodeFor(result)).toBe(1);
    expect(renderSummary(result)).toContain("nothing pushed");
    const [group] = (await readPlan(plan)).groups;
    expect(group?.tests).toMatchObject({ passed: false, attributed: "change" });
    expect(group?.patch).toContain("+    max_completion_tokens: 256,");
    expect(await tree(dir)).toEqual(await tree(BEFORE));
  });

  it("writes an empty plan when there is nothing to fix, and replaces an earlier plan", async () => {
    const dir = await repoWith({ "a.js": "export const a = 1;\n" });
    const plan = join(await planHome(), "plan");
    await mkdir(plan);
    await writeFile(join(plan, "plan.json"), "earlier");
    await fix(dir, { prepare: plan });
    expect(await readPlan(plan)).toEqual({ version: 1, darnit: "dev", base: (await git(dir, ["rev-parse", "HEAD"])).trim(), groups: [] });
  });

  it("refuses a plan folder that is a link, a file, or holds anything else, before touching a file", async () => {
    const dir = await repoFrom(BEFORE);
    const home = await planHome();
    await mkdir(join(home, "real"));
    await symlink(join(home, "real"), join(home, "link"));
    await writeFile(join(home, "file"), "");
    await mkdir(join(home, "full"));
    await writeFile(join(home, "full", "notes.txt"), "keep");
    await mkdir(join(home, "linked-plan"));
    await symlink(join(home, "elsewhere"), join(home, "linked-plan", "plan.json"));
    for (const [name, why] of [["link", "a symbolic link"], ["file", "not a folder"], ["full", "holds no earlier plan"], ["linked-plan", "holds no earlier plan"]]) {
      await expect(fix(dir, { prepare: join(home, name!), test: "node -e 1" })).rejects.toThrow(why);
    }
    expect(await readdir(join(home, "real"))).toEqual([]);
    expect(await readdir(join(home, "full"))).toEqual(["notes.txt"]);
    await expect(access(join(home, "elsewhere"))).rejects.toThrow();
    expect(await tree(dir)).toEqual(await tree(BEFORE));
    expect(runs.count).toBe(0);
  });

  it("removes an earlier plan when it starts, so a run that stops leaves none behind", async () => {
    const dir = await repoFrom(BEFORE);
    const plan = join(await planHome(), "plan");
    await mkdir(plan);
    await writeFile(join(plan, "plan.json"), "earlier");
    await writeFile(join(dir, "notes.txt"), "wip\n");
    await expect(fix(dir, { prepare: plan, noTest: true })).rejects.toThrow(/uncommitted changes/);
    expect(await readdir(plan)).toEqual([]);
  });

  it("refuses a plan folder inside the repository, however it is named", async () => {
    const dir = await repoWith({ "sub/sdk.js": SDK_CALL });
    const home = await planHome();
    await symlink(dir, join(home, "link"));
    for (const [root, plan] of [[dir, dir], [dir, join(dir, "plan")], [dir, join(dir, "new", "plan")], [dir, join(dir, "..plan")], [dir, join(home, "link", "plan")], [join(dir, "sub"), join(dir, "plan")]]) {
      await expect(fix(root!, { prepare: plan!, noTest: true })).rejects.toThrow("is inside the repository");
    }
    expect((await git(dir, ["status", "--porcelain", "--untracked-files=all"])).trim()).toBe("");
    // The folder holding the repository is outside it, though never empty.
    await expect(fix(dir, { prepare: dirname(dir), noTest: true })).rejects.toThrow("holds no earlier plan");
    await fix(dir, { prepare: join(home, "plan"), noTest: true });
    expect((await readPlan(join(home, "plan"))).groups).toHaveLength(1);
  });

  it.each([
    ["put a plan.json link in the folder", (plan: string, target: string) => `mkdir -p ${plan} ${target} && ln -s ${target}/stolen ${plan}/plan.json`, "appeared during the run"],
    ["put a link where the folder goes", (plan: string, target: string) => `mkdir -p ${target} && ln -s ${target} ${plan}`, "became a link during the run"],
  ])("writes no plan when the repository's tests %s", async (_, sabotage, message) => {
    const dir = await repoFrom(BEFORE);
    const home = await planHome();
    const [plan, target] = [join(home, "plan"), join(home, "elsewhere")];
    await expect(fix(dir, { prepare: plan, test: sabotage(plan, target) })).rejects.toThrow(message);
    expect(await readdir(home)).toEqual(expect.arrayContaining(["elsewhere"]));
    expect(await readdir(target).catch(() => [])).toEqual([]);
  });

  it("refuses --pr and --dry-run alongside it, and a dirty tree as --pr does", async () => {
    const dir = await repoFrom(BEFORE);
    const plan = join(await planHome(), "plan");
    await expect(fix(dir, { prepare: plan, pr: true })).rejects.toThrow("--prepare and --pr can't be combined");
    await expect(fix(dir, { prepare: plan, dryRun: true })).rejects.toThrow("--prepare and --dry-run can't be combined");
    await expect(fix(dir, { prepare: plan, repo: "o/r" })).rejects.toThrow("--prepare and --repo can't be combined");
    await writeFile(join(dir, "notes.txt"), "wip\n");
    await expect(fix(dir, { prepare: plan, noTest: true })).rejects.toThrow(/uncommitted changes in the working tree/);
    await expect(access(plan)).rejects.toThrow();
  });

  it.each([
    [["--prepare", "PLAN", "--pr"], "--prepare and --pr can't be combined"],
    [["--prepare", "PLAN", "--json"], "--prepare and --json can't be combined"],
    [["--prepare", "PLAN", "--dry-run"], "--prepare and --dry-run can't be combined"],
    [["--prepare", "PLAN", "--repo", "o/r"], "--prepare and --repo can't be combined"],
    [["--prepare", ""], "--prepare needs the folder to write the plan to"],
    [["--prepare", "--json"], "--prepare needs the folder to write the plan to"],
    [["--prepare"], "argument missing"],
  ])("exits 2 with a clear error for fix %j", async (args, message) => {
    const dir = await repoFrom(BEFORE);
    const plan = join(await planHome(), "plan");
    const run = await darnit(dir, "fix", ...args.map((a) => (a === "PLAN" ? plan : a)));
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
    await expect(access(plan)).rejects.toThrow();
    expect(await tree(dir)).toEqual(await tree(BEFORE));
  });
});

describe("prBody", () => {
  it("shows reviewed notes as readable prose and keeps the vendor quote verbatim as code", async () => {
    const record = (await loadRecords())[0]!.record;
    const hostile = "Use tools.\n# Heading <img src=x onerror=alert(1)> [click](https://evil.example) @octocat";
    const body = prBody(
      { ...record, sources: [{ url: "https://example.com/changelog", quoteId: hostile }], notes: { migration: hostile, edgeCases: [hostile] } },
      ["app.js"],
      "test",
    );
    const lines = body.split("\n");
    expect(lines[0]).toBe(prose(hostile));
    expect(lines).toContain(`- ${prose(hostile)}`);
    expect(lines).toContain("> `Use tools. # Heading <img src=x onerror=alert(1)> [click](https://evil.example) @octocat`");
  });

  it("shows file names, commands and test output from the repository as literal text", async () => {
    const record = (await loadRecords())[0]!.record;
    const file = "a`\n\n- [x] approved by @someone\n\n`.ts";
    const output = "ok\n```\n# Injected\n```\n</details>";
    const tests = { kind: "tests" as const, command: "sh `x`.sh", passed: true, output, timedOut: false };
    const remaining = [{ file, line: 3, note: "sent to [x](https://evil.example)" }];
    const body = prBody(record, [file], "t", { tests, remaining });
    const lines = body.split("\n");
    expect(lines).toContain("- ``a`\\n\\n- [x] approved by @someone\\n\\n`.ts``");
    expect(lines.some((l) => l.startsWith("- [x] approved"))).toBe(false);
    expect(lines).toContain("- [x] ``sh `x`.sh`` passed");
    expect(body).toContain(`\n\`\`\`\`\n${output}\n\`\`\`\`\n`);
    expect(lines).toContain(`- \`\`a\`\\n\\n- [x] approved by @someone\\n\\n\`.ts:3\`\`: ${prose(remaining[0]!.note)}`);
  });

  it("writes out direction overrides and C1 controls in file names and keeps their edge spaces", async () => {
    const record = (await loadRecords())[0]!.record;
    const lines = prBody(record, ["bidi-\u202Egnp\u009b.ts", " a "], "t").split("\n");
    expect(lines).toContain("- `bidi-\\u202egnp\\u009b.ts`");
    expect(lines).toContain("- `  a  `");
  });

  it("stays under GitHub's 65,536-character limit when every character of the test output is written out", async () => {
    const dir = await repoWith({ "a.txt": "a\n" });
    // Kept output is cut to 16,384 characters, and U+200B takes six once written out.
    const run = await runTests(dir, `node -e "for (let i = 0; i < 60; i++) console.log('\\u200b'.repeat(2000))"`);
    const tests = { ...run, kind: "tests" as const };
    for (const { record } of await loadRecords()) expect(prBody(record, ["app.py"], "t", { tests }).length).toBeLessThan(65_536);
    expect(run.output.length).toBeLessThanOrEqual(16 * 1024);
    expect(run.output).toMatch(/^(\\u200b)+$/m);
  });

  it("writes out zero-width characters in file names and keeps joined emoji whole", async () => {
    const record = (await loadRecords())[0]!.record;
    const lines = prBody(record, ["a👨\u200D👩.ts", "z\u200Bw\u2060\uFEFF.ts"], "t").split("\n");
    expect(lines).toContain("- `a👨\u200D👩.ts`");
    expect(lines).toContain("- `z\\u200bw\\u2060\\ufeff.ts`");
  });

  it("writes out direction-changing characters in test output and leaves ordinary Unicode alone", async () => {
    const record = (await loadRecords())[0]!.record;
    const output = 'FAIL app.test.ts\n  max_tokens: /*\u202E\u2066*/ cap("\u202Eab\u2069\u009b1A") // café 日本 🎉 👨‍👩‍👧 שלום';
    const tests = { kind: "tests" as const, command: "npm test", passed: false, timedOut: false, output };
    const body = prBody(record, ["app.ts"], "t", { tests });
    expect(body).not.toMatch(/[\u0080-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
    expect(body).toContain('max_tokens: /*\\u202e\\u2066*/ cap("\\u202eab\\u2069\\u009b1A") // café 日本 🎉 👨‍👩‍👧 שלום');
  });

  it("links every record in the footer to its page on darnit.sh", async () => {
    const loaded = await loadRecords();
    expect(loaded.length).toBeGreaterThan(0);
    for (const { record, packDir } of loaded) {
      const folder = relative(PACKS_DIR, packDir).split(sep).join("/");
      const footer = prBody(record, ["app.js"], "1.2.3").trimEnd().split("\n").at(-1);
      expect(footer).toBe(`darnit 1.2.3, change record [\`${record.id}\`](https://darnit.sh/changes/${folder})`);
    }
  });
});

describe("forTerminal", () => {
  it("keeps line breaks, drops C0 control characters and color codes, and writes out C1 ones", () => {
    const text = "\u001b[31mred\u001b[0m\tok\n\u001b]52;c;Zm9v\u0007clip\u001b[2Jwipe\rover\u009b1Ahide\u0000\u007f";
    expect(forTerminal(text, false, {})).toBe("[31mred[0m\tok\n]52;c;Zm9vclip[2Jwipeover\\u009b1Ahide\\u007f");
    expect(forTerminal(text, true, {})).toBe(forTerminal(text, false, {}));
  });

  it("colors a diff the way git does, with no color codes from its text", () => {
    const codes = "\u001b[8mhidden\u001b[0m \u001b[30;40m\u001b[38;2;0;0;0m\u001b[2J";
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "index 1..2 100644",
      "--- a/x.ts",
      "+++ b/x.ts",
      `@@ -1,3 +1,3 @@ f(${codes})`,
      ` same ${codes}`,
      `-old ${codes}`,
      "-- removed",
      `+new ${codes} \t `,
      "+++ added",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const plain = "[8mhidden[0m [30;40m[38;2;0;0;0m[2J";
    expect(forTerminal(diff, true, {}).split("\n")).toEqual([
      "\u001b[1mdiff --git a/x.ts b/x.ts\u001b[m",
      "\u001b[1mindex 1..2 100644\u001b[m",
      "\u001b[1m--- a/x.ts\u001b[m",
      "\u001b[1m+++ b/x.ts\u001b[m",
      `\u001b[36m@@ -1,3 +1,3 @@\u001b[m f(${plain})`,
      ` same ${plain}`,
      `\u001b[31m-old ${plain}\u001b[m`,
      "\u001b[31m-- removed\u001b[m",
      `\u001b[32m+new ${plain}\u001b[m\u001b[41m \t \u001b[m`,
      "\u001b[32m+++ added\u001b[m",
      "\\ No newline at end of file",
      "",
    ]);
    expect(forTerminal(diff, false, {})).toBe(diff.replaceAll("\u001b", ""));
  });

  it("colors a hostile diff quickly", async () => {
    const diff = `diff --git a/x b/x\n@@ -1 +1 @@\n+${" ".repeat(200_000)}x\n+${"\t".repeat(200_000)}\n${"+ \n-\n".repeat(100_000)}`;
    expect(await cpuTime(() => forTerminal(diff, true, {}), 3, 300)).toBeLessThan(300);
  });

  it("writes out every direction-changing, zero-width and line-separating character, and leaves ordinary Unicode alone", () => {
    const hidden = "\u061c\u200b\u200e\u200f\u2028\u2029\u202a\u202b\u202c\u202d\u202e\u2060\u2061\u2062\u2063\u2064\u2066\u2067\u2068\u2069\ufeff";
    expect(forTerminal(`a${hidden}b`, false, {})).toBe(`a${[...hidden].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}b`);
    const plain = "café naïve 日本語 한국어 🎉 👨‍👩‍👧 👨\u200D👩 مرحبا שלום Ωµ ~!@#$%^&*()_+{}|:\"<>?`-=[]\\;',./";
    expect(forTerminal(plain, false, {})).toBe(plain);
    expect(forTerminal(plain, true, {})).toBe(plain);
  });

  it("fences the text with a new token each time in GitHub Actions only, and keeps it exact", () => {
    const text = "::error::a\n \u00a0::add-mask::b\r\n::stop-commands::c\n";
    const actions = { GITHUB_ACTIONS: "true" };
    const [a, b] = [forTerminal(text, false, actions), forTerminal(text, false, actions)];
    const [, token, inside] = /^::stop-commands::(\S+)\n([^]*)\n::\1::$/.exec(a) ?? [];
    expect(inside).toBe("::error::a\n \u00a0::add-mask::b\n::stop-commands::c\n");
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(b).not.toContain(token);
    expect(forTerminal("", false, actions)).toMatch(/^::stop-commands::(\S+)\n\n::\1::$/);
    for (const env of [{}, { GITHUB_ACTIONS: "false" }, { GITHUB_ACTIONS: "" }]) expect(forTerminal(text, false, env)).toBe(inside);
    expect(notDarnits(`${a}\n${b}\n::notice::mine\n`)).toEqual({ ran: ["::notice::mine"], stopped: false });
  });
});

describe("prose", () => {
  // What GitHub would read as Markdown: everything outside code spans.
  const outside = (s: string) => s.replace(/`[^`]*`/g, " ");
  const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u061C\uFEFF]/;

  it("reads like the original text", () => {
    const note = "Request-side rename: max_tokens: N becomes max_completion_tokens: N on chat.completions.create calls.";
    expect(prose(note).replace(/\\(.)/g, "$1")).toBe(note);
    expect(prose("Use `max_completion_tokens` instead")).toBe("Use `max_completion_tokens` instead");
  });

  it("shows words GitHub could make live as code, which copies exactly", () => {
    expect(prose("see https://platform.openai.com/docs, then ping @octocat.")).toBe("see `https://platform.openai.com/docs`, then ping `@octocat`.");
  });

  // Every input that GitHub would otherwise turn into a link, ping, reference, image, HTML, block,
  // emoji or math. Each was confirmed live on GitHub's renderer before the matching rule existed.
  it.each([
    ["mention", "ping @octocat", /@/],
    ["issue reference", "see #12", /(?<!\\)#/],
    ["cross-repo path", "cli/cli/pull/1", /\//],
    ["URL", "https://evil.example", /:\//],
    ["www", "www.evil.example and _www.x and See www. for", /www/i],
    ["commit SHA", "fixed in 17142e08db2e", /[0-9a-f]{7}/i],
    ["GH reference", "see GH-1", /-\d/],
    ["custom reference", "see JIRA-123", /-\d/],
    ["math", "costs $5 to $10", /(?<!\\)\$/],
    ["emoji", "done :white_check_mark: ok", /:\S/],
    ["HTML", "<img src=x onerror=alert(1)>", /(?<!\\)</],
    ["link", "[click](javascript:alert(1))", /(?<!\\)\[/],
    ["setext heading", "---", /^-/],
    ["ordered list", "1. item", /^1\./],
    ["entity", "&#64;octocat", /(?<!\\)&/],
  ])("defuses %s", (_name, input, live) => {
    const out = prose(input);
    expect(outside(out)).not.toMatch(live);
    expect(out).not.toMatch(INVISIBLE);
  });

  it("writes out invisible and direction-changing characters in its input", () => {
    expect(prose("a\u200Bb\u202Ec\uFEFFd")).toBe("a\\\\u200bb\\\\u202ec\\\\ufeffd");
  });

  it("stays fast on hostile input", async () => {
    expect(await cpuTime(() => prose(`${".".repeat(50000)}a`), 3, 500)).toBeLessThan(500);
  });
});

describe("the repository's config names no program git runs in darnit's own calls", () => {
  const BEFORE = join(PACKS, "openai", "2024-09-12-max-tokens-to-max-completion-tokens", "fixtures", "basic", "before");
  const execFileP = promisify(execFile);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // Each key class, set so git would run a marker-writing program if a darnit call let it. Programs
  // reached through the shell (external diff, textconv, a filter, a pager) take an inline command; the
  // ones git execs directly (fsmonitor, gpg, a hook) need a script, kept outside the repo so the tree stays clean.
  const cmd = (marker: string, tail: string) => `touch '${marker}'; ${tail}`;
  async function script(path: string, marker: string): Promise<string> {
    await writeFile(path, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    await chmod(path, 0o755);
    return path;
  }
  type Setup = (dir: string, probe: string, marker: string) => Promise<void>;
  const KEYS: Record<string, Setup> = {
    "diff.external": async (dir, _p, m) => void (await git(dir, ["config", "diff.external", cmd(m, "true")])),
    "a textconv driver": async (dir, _p, m) => {
      await appendFile(join(dir, ".gitattributes"), "*.py diff=probe\n");
      await git(dir, ["config", "diff.probe.textconv", cmd(m, "cat")]);
    },
    "gpg.program with commit.gpgSign": async (dir, probe, m) => {
      await git(dir, ["config", "commit.gpgSign", "true"]);
      await git(dir, ["config", "gpg.format", "openpgp"]);
      await git(dir, ["config", "gpg.program", await script(join(probe, "gpg"), m)]);
    },
    "core.fsmonitor": async (dir, probe, m) => void (await git(dir, ["config", "core.fsmonitor", await script(join(probe, "fsm"), m)])),
    "a pre-commit hook via core.hooksPath": async (dir, probe, m) => {
      await mkdir(join(probe, "hooks"), { recursive: true });
      await script(join(probe, "hooks", "pre-commit"), m);
      await git(dir, ["config", "core.hooksPath", join(probe, "hooks")]);
    },
    "a clean/smudge filter": async (dir, _p, m) => {
      await appendFile(join(dir, ".gitattributes"), "*.py filter=probe\n");
      await git(dir, ["config", "filter.probe.clean", cmd(m, "cat")]);
      await git(dir, ["config", "filter.probe.smudge", cmd(m, "cat")]);
      await git(dir, ["config", "filter.probe.required", "true"]);
    },
    // A driver name holding `=` would survive a `-c filter.<name>.clean=` pin, which git splits at the first `=`.
    "a filter driver named with =": async (dir, _p, m) => {
      await appendFile(join(dir, ".gitattributes"), "*.py filter=a=b\n");
      await git(dir, ["config", "filter.a=b.clean", cmd(m, "cat")]);
      await git(dir, ["config", "filter.a=b.required", "true"]);
    },
    // A process filter stands in for both clean and smudge, so its own pin must turn it off.
    "a process filter": async (dir, _p, m) => {
      await appendFile(join(dir, ".gitattributes"), "*.py filter=proc\n");
      await git(dir, ["config", "filter.proc.process", cmd(m, "cat")]);
      await git(dir, ["config", "filter.proc.required", "true"]);
    },
    "gpg.program with push.gpgSign": async (dir, probe, m) => {
      await git(dir, ["config", "push.gpgSign", "true"]);
      await git(dir, ["config", "gpg.format", "openpgp"]);
      await git(dir, ["config", "gpg.program", await script(join(probe, "gpg"), m)]);
    },
    "core.pager": async (dir, _p, m) => void (await git(dir, ["config", "core.pager", cmd(m, "cat")])),
  };

  async function setup(set: Setup): Promise<{ dir: string; marker: string }> {
    const dir = await repoFrom(BEFORE);
    const probe = await mkdtemp(join(tmpdir(), "darnit-probe-"));
    tempDirs.push(probe);
    const marker = join(probe, "ran");
    await set(dir, probe, marker);
    return { dir, marker };
  }
  const ran = (marker: string) => access(marker).then(() => true, () => false);

  it.each(Object.keys(KEYS))("runs no program %s names", async (key) => {
    const set = KEYS[key]!;

    // check, and the fix modes that read and rewrite the working tree.
    const a = await setup(set);
    await checkReport(a.dir);
    await fix(a.dir, { dryRun: true, noTest: true });
    await fix(a.dir, { noTest: true });
    expect(await ran(a.marker), `${key}: check, --dry-run or fix`).toBe(false);

    // --prepare writes the plan patch with no token and no ssh agent in the environment.
    const b = await setup(set);
    for (const k of ["GITHUB_TOKEN", "GH_TOKEN", "SSH_AUTH_SOCK"]) vi.stubEnv(k, "");
    await fix(b.dir, { prepare: join(await planHome(), "plan"), noTest: true, allowDirty: true });
    expect(await ran(b.marker), `${key}: --prepare`).toBe(false);
    vi.unstubAllEnvs();

    // --pr commits to a branch and pushes to a local bare remote, GitHub's API stubbed.
    const c = await setup(set);
    const bare = await mkdtemp(join(tmpdir(), "darnit-origin-"));
    tempDirs.push(bare);
    await git(bare, ["init", "-q", "--bare"]);
    // Advertise push-cert support so push.gpgSign actually tries to sign.
    await git(bare, ["config", "receive.certNonceSeed", "seed"]);
    await git(c.dir, ["remote", "add", "origin", bare]);
    const branch = (await git(c.dir, ["symbolic-ref", "--short", "HEAD"])).trim();
    await git(c.dir, ["push", "-q", "-u", "origin", branch], 60);
    vi.stubEnv("GITHUB_TOKEN", "test-token");
    vi.stubGlobal("fetch", (url: string, init?: RequestInit): Promise<Response> => {
      const body = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status }));
      void init;
      if (url.endsWith("/repos/o/r")) return body({ default_branch: branch });
      if (url.includes("/pulls?")) return body([]);
      return body({ html_url: "https://github.com/o/r/pull/1" }, 201);
    });
    await fix(c.dir, { pr: true, noTest: true, repo: "o/r", allowDirty: true });
    expect(await ran(c.marker), `${key}: --pr`).toBe(false);
  });

  // git's status and diff start a status inside a submodule, which runs that submodule's own filters.
  it("does not descend into a submodule, whose own config names a filter", async () => {
    const sub = await mkdtemp(join(tmpdir(), "darnit-sub-"));
    tempDirs.push(sub);
    await git(sub, ["init", "-q"]);
    await writeFile(join(sub, "s.py"), "s\n");
    await git(sub, ["add", "s.py"]);
    await git(sub, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "s"]);
    const { dir, marker } = await setup(() => Promise.resolve());
    await execFileP("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub"], { cwd: dir });
    await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "sub"]);
    // The submodule's own config runs a filter on a stat-dirty file, even against -c diff.ignoreSubmodules.
    await appendFile(join(dir, "sub", ".gitattributes"), "s.py filter=ev\n");
    await git(join(dir, "sub"), ["config", "filter.ev.process", cmd(marker, "cat")]);
    await git(join(dir, "sub"), ["config", "filter.ev.required", "true"]);
    await git(dir, ["config", "submodule.sub.ignore", "none"]);
    await writeFile(join(dir, "sub", "s.py"), "s\n");
    await checkReport(dir);
    await fix(dir, { noTest: true, allowDirty: true });
    expect(await ran(marker)).toBe(false);
  });

  // A hostile repository with a vast filter list must not slip a real filter past a dropped or
  // overlong set of pins: darnit refuses rather than run git against it.
  it("refuses a repository that configures more filter drivers than it will turn off", async () => {
    const { dir, marker } = await setup(async (d, _p, m) => {
      await appendFile(join(d, ".gitattributes"), "*.py filter=evil\n");
      const lines = [`[filter "evil"]\n\tclean = ${cmd(m, "cat")}\n\trequired = true\n`];
      for (let i = 0; i < 400; i++) lines.push(`[filter "pad${"x".repeat(200)}${i}"]\n\tclean = cat\n`);
      await writeFile(join(d, "filters.cfg"), lines.join(""));
      await git(d, ["config", "include.path", join(d, "filters.cfg")]);
    });
    await expect(fix(dir, { noTest: true, allowDirty: true })).rejects.toThrow(/over darnit's limit/);
    expect(await ran(marker)).toBe(false);
  });
});
