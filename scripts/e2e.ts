// Packs darnit exactly as npm would ship it, installs the tarball into an empty
// folder, and runs init, check and fix against every scenario in test/e2e/.
// Unit tests import the source; this checks the artifact users actually get.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

// No run may reach the npm registry.
process.env.DARNIT_NO_UPDATE_CHECK = "1";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCENARIOS = join(ROOT, "test", "e2e");

type Run = { exit: number; has: string[]; lacks?: string[] };

type Expect = {
  check: Run;
  fix: Run;
  /** Files `fix` should leave modified; every other file must be untouched. */
  changed: string[];
  /** Text that must be in a file after fix. */
  keeps?: [file: string, text: string][];
  /** Text that must be gone from a file after fix. */
  drops?: [file: string, text: string][];
};

// A rewrite that claims success but left a call site behind is a failure here.
const CLEAN_FIX = ["needs a human", "0 of"];

const NOT_COVERED = "found in 1 file, not rewritten: the rewrite rules don't cover this call shape yet";

const EXPECT: Record<string, Expect> = {
  "01-js-basic": {
    check: { exit: 1, has: ["src/summarize.js:5:5  max_tokens: 256"] },
    fix: { exit: 0, has: ["✓ Rename max_tokens", "tests: npm test passed"], lacks: CLEAN_FIX },
    changed: ["src/summarize.js"],
    keeps: [["src/summarize.js", "max_completion_tokens: 256,"]],
    drops: [["src/summarize.js", "max_tokens"]],
  },
  "02-ts-mixed": {
    check: { exit: 1, has: ["src/llm.ts:11:5  max_tokens: 512"], lacks: ["src/llm.ts:19"] },
    fix: { exit: 0, has: ["✓ Rename max_tokens"], lacks: CLEAN_FIX },
    changed: ["src/llm.ts"],
    keeps: [
      ["src/llm.ts", "max_completion_tokens: 512,"],
      ["src/llm.ts", "max_tokens: 1024,"],
    ],
    drops: [["src/llm.ts", "max_tokens: 512"]],
  },
  "03-py-pytest": {
    check: { exit: 1, has: ["app/summarize.py:5:9  max_tokens=256"] },
    fix: { exit: 0, has: ["✓ Rename max_tokens", "-m pytest -q passed"], lacks: CLEAN_FIX },
    changed: ["app/summarize.py"],
    keeps: [["app/summarize.py", "max_completion_tokens=256,"]],
    drops: [["app/summarize.py", "max_tokens"]],
  },
  "04-raw-fetch": {
    check: { exit: 1, has: ["client.js:8:7  max_tokens: 100"] },
    fix: { exit: 0, has: [NOT_COVERED] },
    changed: [],
  },
  "05-functions-legacy": {
    check: { exit: 1, has: ["weather.js:9:5", "weather.js:10:5"] },
    fix: { exit: 0, has: ["found in 1 file, not rewritten: migration not yet automated; see the record notes"] },
    changed: [],
  },
  "06-test-breaks": {
    check: { exit: 1, has: ["src/summarize.js:5:5"] },
    fix: { exit: 1, has: ["✗ Rename max_tokens", "rewritten, then put back", "The change broke your tests."], lacks: ["✓"] },
    changed: [],
  },
  "07-already-red": {
    check: { exit: 1, has: ["src/summarize.js:5:5"] },
    fix: { exit: 1, has: ["✗ Rename max_tokens", "They already fail without the change.", "rerun with --no-test"], lacks: ["✓"] },
    changed: [],
  },
  "08-clean": {
    check: { exit: 0, has: ["No known vendor changes affect this repository.", "Scanned 1 JavaScript, TypeScript or Python file"] },
    fix: { exit: 0, has: ["Nothing to fix."] },
    changed: [],
  },
  "10-ts-old-sdk": {
    check: { exit: 1, has: ["src/draft.ts:9:5  max_tokens: 512"] },
    fix: {
      exit: 1,
      has: ["✗ Rename max_tokens", "could not confirm openai >= 4.60.0 (npm)", "build: npm run typecheck failed; files put back. The change broke your build."],
      lacks: ["✓"],
    },
    changed: [],
  },
  "12-js-old-lock": {
    check: { exit: 1, has: ["src/summarize.js:5:5  max_tokens: 256"] },
    fix: { exit: 0, has: ["found in 1 file, not rewritten: needs openai >= 4.60.0, this repo has 4.20.0 (package-lock.json); upgrade it first"] },
    changed: [],
  },
  "13-groq-sdk": {
    check: { exit: 0, has: ["No known vendor changes affect this repository.", "Left out 1 call made through another provider's client with the same methods: src/chat.js:9."] },
    fix: { exit: 0, has: ["Nothing to fix."] },
    changed: [],
  },
  "14-openrouter-baseurl": {
    check: { exit: 0, has: ["No known vendor changes affect this repository.", "Left out 1 call made through another provider's client"] },
    fix: { exit: 0, has: ["Nothing to fix."] },
    changed: [],
  },
  "15-mixed-clients": {
    check: { exit: 1, has: ["src/chat.js:8:", "Left out 1 call made through another provider's client"], lacks: ["src/chat.js:11:"] },
    fix: { exit: 0, has: ["found in 1 file, not rewritten: this file also calls another provider through the same methods"] },
    changed: [],
  },
  // Its .npmrc runs its own files under npm, as fix runs `npm test`; the run below checks the workflow line.
  "16-hostile-repo": {
    check: { exit: 1, has: ["src/summarize.js:5:5  max_tokens: 256"] },
    fix: { exit: 0, has: ["✓ Rename max_tokens", "tests: npm test passed"], lacks: CLEAN_FIX },
    changed: ["src/summarize.js"],
  },
  "11-py-old-sdk": {
    check: { exit: 1, has: ["app/summarize.py:5:9  max_tokens=256"] },
    fix: { exit: 0, has: ["found in 1 file, not rewritten: needs openai >= 1.45.0, this repo has 1.40.0 (requirements.txt); upgrade it first"] },
    changed: [],
  },
  "09-options-elsewhere": {
    check: { exit: 0, has: ["No known vendor changes affect this repository.", "Not checked: request options built elsewhere"] },
    fix: { exit: 0, has: ["Nothing to fix."] },
    changed: [],
  },
};

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout: 5 * 60 * 1000 });
  if (r.error) return { exit: -1, out: `${cmd} did not finish: ${r.error.message}` };
  return { exit: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

function must(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  const r = run(cmd, args, cwd, env);
  if (r.exit !== 0) throw new Error(`${cmd} ${args.join(" ")} failed in ${cwd}:\n${r.out}`);
  return r.out;
}

// A scenario folder without expectations, or expectations without a folder, is a mistake, not a skip.
const folders = readdirSync(SCENARIOS).sort();
if (JSON.stringify(folders) !== JSON.stringify(Object.keys(EXPECT).sort())) {
  throw new Error(`test/e2e folders [${folders.join(", ")}] do not match the expectations [${Object.keys(EXPECT).join(", ")}]`);
}

const work = mkdtempSync(join(tmpdir(), "darnit-e2e-"));
let failures = 0;
try {
  must("npm", ["pack", "--silent", "--pack-destination", work], ROOT);
  const tarball = join(work, readdirSync(work).find((f) => f.endsWith(".tgz"))!);
  const install = join(work, "install");
  mkdirSync(install);
  must("npm", ["init", "-y"], install);
  must("npm", ["install", "--silent", tarball], install);
  const darnit = join(install, "node_modules", ".bin", "darnit");
  console.log(`darnit ${must(darnit, ["--version"], install).trim()} from ${tarball}\n`);
  // A mistyped flag is darnit failing (2), never "call sites found" (1), which would turn a scheduled run red.
  const usage = run(darnit, ["check", "--no-such-flag"], install);
  if (usage.exit !== 2) {
    failures++;
    console.log(`✗ usage error exited ${usage.exit}, expected 2\n${usage.out}`);
  } else console.log("✓ usage error exits 2");
  const missing = run(darnit, ["check", join(work, "no-such-folder")], install);
  if (missing.exit !== 2 || !missing.out.includes("no-such-folder is not a folder")) {
    failures++;
    console.log(`✗ a missing folder exited ${missing.exit}, expected 2 and "is not a folder"\n${missing.out}`);
  } else console.log("✓ a missing folder exits 2");

  for (const [name, want] of Object.entries(EXPECT).sort(([a], [b]) => a.localeCompare(b))) {
    const dir = join(work, name);
    cpSync(join(SCENARIOS, name), dir, { recursive: true });
    // The .npmrc in 16-hostile-repo finds its files the way it would in a workflow run.
    let env: NodeJS.ProcessEnv = { ...process.env, GITHUB_WORKSPACE: dir };
    // Scenarios that list pytest get a virtualenv with it, so their suite can run.
    const requirements = readdirSync(dir).includes("requirements.txt") ? readFileSync(join(dir, "requirements.txt"), "utf8") : "";
    if (requirements.includes("pytest")) {
      must("python3", ["-m", "venv", ".venv"], dir);
      must(join(dir, ".venv", "bin", "python"), ["-m", "pip", "install", "--quiet", "pytest"], dir);
      env = { ...env, PATH: `${join(dir, ".venv", "bin")}${delimiter}${process.env.PATH ?? ""}` };
    }
    const git = (...args: string[]) => must("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...args], dir, env);
    git("init", "-q");
    must(darnit, ["init"], dir, env);
    git("add", "-A");
    git("commit", "-qm", "start");

    const problems: string[] = [];
    const expectRun = (label: string, r: { exit: number; out: string }, exp: Run) => {
      if (r.exit !== exp.exit) problems.push(`${label} exited ${r.exit}, expected ${exp.exit}`);
      for (const s of exp.has) if (!r.out.includes(s)) problems.push(`${label} output lacks: ${s}`);
      for (const s of exp.lacks ?? []) if (r.out.includes(s)) problems.push(`${label} output should not contain: ${s}`);
    };
    const check = run(darnit, ["check"], dir, env);
    expectRun("check", check, want.check);
    const outside = run(darnit, ["check", dir], install, env);
    if (outside.exit !== check.exit || outside.out !== check.out) problems.push(`check run from outside differs:\n${outside.out}`);
    const fix = run(darnit, ["fix"], dir, env);
    expectRun("fix", fix, want.fix);

    const changed = must("git", ["status", "--porcelain", "--untracked-files=no"], dir)
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3))
      .sort();
    if (JSON.stringify(changed) !== JSON.stringify([...want.changed].sort())) {
      problems.push(`fix changed [${changed.join(", ")}], expected [${want.changed.join(", ")}]`);
    }
    for (const [file, text] of want.keeps ?? []) {
      if (!readFileSync(join(dir, file), "utf8").includes(text)) problems.push(`${file} should contain: ${text}`);
    }
    for (const [file, text] of want.drops ?? []) {
      if (readFileSync(join(dir, file), "utf8").includes(text)) problems.push(`${file} should no longer contain: ${text}`);
    }

    if (problems.length === 0) console.log(`✓ ${name}`);
    else {
      failures++;
      console.log(`✗ ${name}\n${problems.map((p) => `    ${p}`).join("\n")}\n  check output:\n${check.out}\n  fix output:\n${fix.out}`);
    }
  }

  // The workflow init writes, run as Actions runs it with the packed darnit in place of npm's. In
  // 16-hostile-repo, npx started inside the repository would run the repository's files; started from
  // RUNNER_TEMP it runs none of them and still reports the repository's call site.
  const hostile = join(work, "hostile");
  cpSync(join(SCENARIOS, "16-hostile-repo"), hostile, { recursive: true });
  must(darnit, ["init"], hostile);
  const line = /^\s*- run: (.*npx darnit@\S+.*)$/m.exec(readFileSync(join(hostile, ".github", "workflows", "darnit.yml"), "utf8"))![1]!;
  const packed = (cmd: string) => cmd.replace(/darnit@\S+/, `--package='${tarball}' darnit`);
  const runnerTemp = join(work, "runner-temp");
  const npmCache = join(work, "npm-cache");
  mkdirSync(runnerTemp);
  mkdirSync(npmCache);
  // npx installs into its own cache folder; this one reuses the downloads `npm install` just made, offline,
  // and goes away with the work folder.
  symlinkSync(join(must("npm", ["config", "get", "cache"], install).trim(), "_cacache"), join(npmCache, "_cacache"));
  const actions = {
    ...process.env,
    RUNNER_TEMP: runnerTemp,
    GITHUB_WORKSPACE: hostile,
    npm_config_cache: npmCache,
    npm_config_prefix: join(work, "no-global"),
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
  const ran = () => readdirSync(hostile).filter((f) => f.startsWith("ran-"));
  for (const [label, cmd, breached] of [
    ["workflow line", packed(line), false],
    ["npx started inside the repository", packed("npx darnit@pin check"), true],
  ] as const) {
    const r = run("sh", ["-c", cmd], hostile, actions);
    const markers = ran();
    for (const f of markers) rmSync(join(hostile, f));
    const ok = breached ? markers.length > 0 : markers.length === 0 && r.exit === 1 && r.out.includes("src/summarize.js:5:5  max_tokens: 256");
    if (ok) console.log(`✓ ${label}: ${breached ? `the repository ran ${markers.join(", ")}` : "ran none of the repository's files"}`);
    else {
      failures++;
      console.log(`✗ ${label} (${cmd}): exited ${r.exit}, repository files that ran: [${markers.join(", ")}]\n${r.out}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const total = Object.keys(EXPECT).length;
console.log(`\n${total - failures} passed, ${failures} failed, ${total} scenarios`);
process.exitCode = failures > 0 ? 1 : 0;
