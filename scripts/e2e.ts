// Packs darnit exactly as npm would ship it, installs the tarball into an empty
// folder, and runs init, check and fix against every scenario in test/e2e/.
// Unit tests import the source; this checks the artifact users actually get.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCENARIOS = join(ROOT, "test", "e2e");

type Expect = {
  check: { exit: number; has: string[]; lacks?: string[] };
  fix: { exit: number; has: string[] };
  /** Files `fix` should leave modified; every other file must be untouched. */
  changed: string[];
  /** Text that must still be in a file after fix. */
  keeps?: [file: string, text: string];
};

const NOT_COVERED = "found, but the rewrite rules don't cover this call shape yet";

const EXPECT: Record<string, Expect> = {
  "01-js-basic": {
    check: { exit: 1, has: ["src/summarize.js:5:5  max_tokens: 256"] },
    fix: { exit: 0, has: ["✓ Rename max_tokens", "tests: npm test passed"] },
    changed: ["src/summarize.js"],
  },
  "02-ts-mixed": {
    check: { exit: 1, has: ["src/llm.ts:11:5  max_tokens: 512"], lacks: ["src/llm.ts:19"] },
    fix: { exit: 0, has: ["✓ Rename max_tokens"] },
    changed: ["src/llm.ts"],
    keeps: ["src/llm.ts", "max_tokens: 1024"],
  },
  "03-py-pytest": {
    check: { exit: 1, has: ["app/summarize.py:5:9  max_tokens=256"] },
    fix: { exit: 0, has: ["✓ Rename max_tokens", "-m pytest -q passed"] },
    changed: ["app/summarize.py"],
  },
  "04-raw-fetch": {
    check: { exit: 1, has: ["client.js:8:7  max_tokens: 100"] },
    fix: { exit: 0, has: [NOT_COVERED] },
    changed: [],
  },
  "05-functions-legacy": {
    check: { exit: 1, has: ["weather.js:9:5", "weather.js:10:5"] },
    fix: { exit: 0, has: ["migration not yet automated; see the record notes"] },
    changed: [],
  },
  "06-test-breaks": {
    check: { exit: 1, has: ["src/summarize.js:5:5"] },
    fix: { exit: 1, has: ["The change broke your tests."] },
    changed: [],
  },
  "07-already-red": {
    check: { exit: 1, has: ["src/summarize.js:5:5"] },
    fix: { exit: 1, has: ["They already fail without the change."] },
    changed: [],
  },
  "08-clean": {
    check: { exit: 0, has: ["No known vendor changes affect this repository.", "Scanned 1 JavaScript, TypeScript or Python file"] },
    fix: { exit: 0, has: ["Nothing to fix."] },
    changed: [],
  },
  "09-options-elsewhere": {
    check: { exit: 0, has: ["No known vendor changes affect this repository.", "Not checked: request options built elsewhere"] },
    fix: { exit: 0, has: ["Nothing to fix."] },
    changed: [],
  },
};

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
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

  for (const [name, want] of Object.entries(EXPECT)) {
    const dir = join(work, name);
    cpSync(join(SCENARIOS, name), dir, { recursive: true });
    let env = process.env;
    if (readdirSync(dir).includes("requirements.txt")) {
      must("python3", ["-m", "venv", ".venv"], dir);
      must(join(dir, ".venv", "bin", "python"), ["-m", "pip", "install", "--quiet", "pytest"], dir);
      env = { ...process.env, PATH: `${join(dir, ".venv", "bin")}${delimiter}${process.env.PATH ?? ""}` };
    }
    const git = (...args: string[]) => must("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...args], dir, env);
    git("init", "-q");
    must(darnit, ["init"], dir, env);
    git("add", "-A");
    git("commit", "-qm", "start");

    const problems: string[] = [];
    const expectRun = (label: string, r: { exit: number; out: string }, exp: { exit: number; has: string[]; lacks?: string[] }) => {
      if (r.exit !== exp.exit) problems.push(`${label} exited ${r.exit}, expected ${exp.exit}`);
      for (const s of exp.has) if (!r.out.includes(s)) problems.push(`${label} output lacks: ${s}`);
      for (const s of exp.lacks ?? []) if (r.out.includes(s)) problems.push(`${label} output should not contain: ${s}`);
    };
    const check = run(darnit, ["check"], dir, env);
    expectRun("check", check, want.check);
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
    if (want.keeps && !readFileSync(join(dir, want.keeps[0]), "utf8").includes(want.keeps[1])) {
      problems.push(`${want.keeps[0]} lost: ${want.keeps[1]}`);
    }

    if (problems.length === 0) console.log(`✓ ${name}`);
    else {
      failures++;
      console.log(`✗ ${name}\n${problems.map((p) => `    ${p}`).join("\n")}\n  check output:\n${check.out}\n  fix output:\n${fix.out}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const total = Object.keys(EXPECT).length;
console.log(`\n${total - failures} passed, ${failures} failed, ${total} scenarios`);
process.exitCode = failures > 0 ? 1 : 0;
