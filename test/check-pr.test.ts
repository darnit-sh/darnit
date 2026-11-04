import { execFileSync, spawn, spawnSync } from "node:child_process";
import { access, constants, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

type Step = { id?: string; if?: string; run?: string; uses?: string; shell?: string; env?: Record<string, string> };
type Job = { env?: Record<string, string>; steps?: Step[] };
const workflow = async (name: string) =>
  parse(await readFile(`.github/workflows/${name}.yml`, "utf8")) as { jobs: Record<string, Job> };
const step = (await workflow("pr")).jobs.title!.steps!.find((s) => s.run)!.run!;
const checker = await readFile("scripts/check-pr.sh", "utf8");
const common = await readFile("scripts/pr-common.sh", "utf8");

/**
 * Runs the title job's step on a repo whose base holds `base` as scripts/check-pr.sh (none for null) and
 * whose head holds `head`, as the job would for a pull request titled `title`.
 */
async function titleJob(title: string, base: string | null, head: string) {
  const dir = await mkdtemp(join(tmpdir(), "darnit-title-"));
  const temp = await mkdtemp(join(tmpdir(), "darnit-title-runner-"));
  tempDirs.push(dir, temp);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  await mkdir(join(dir, "scripts"));
  await writeFile(join(dir, "scripts/other.sh"), "");
  await writeFile(join(dir, "scripts/pr-common.sh"), common);
  if (base !== null) await writeFile(join(dir, "scripts/check-pr.sh"), base);
  git("add", ".");
  git("commit", "-q", "-m", "ci: base");
  const baseSha = git("rev-parse", "HEAD");
  await writeFile(join(dir, "scripts/check-pr.sh"), head);
  git("add", ".");
  git("commit", "-q", "-m", "ci: head");
  const summary = join(temp, "summary");
  const r = spawnSync("bash", ["-e", "-c", step], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      TITLE: title,
      AUTHOR: "someone",
      BASE: baseSha,
      HEAD: git("rev-parse", "HEAD"),
      RUNNER_TEMP: temp,
      GITHUB_STEP_SUMMARY: summary,
    },
  });
  return { status: r.status, out: r.stdout };
}

describe("the title job", () => {
  it("judges a change with base's check, so a change cannot loosen the check that judges it", async () => {
    const loosened = await titleJob("wip", checker, "exit 0\n");
    expect(loosened.status).toBe(1);
    expect(loosened.out).toContain("Check from base's scripts/check-pr.sh");
    expect(loosened.out).toContain("::error::title is not type(scope): summary: wip");
    expect((await titleJob("ci: tidy the title check", checker, "exit 0\n")).status).toBe(0);
  });

  it("uses the change's own check when base has none", async () => {
    const added = await titleJob("ci: add the title check", null, checker);
    expect(added.status).toBe(0);
    expect(added.out).toContain("this change's scripts/check-pr.sh, since base has none");
    expect((await titleJob("wip", null, checker)).status).toBe(1);
  });
});

describe("npm in CI", () => {
  // npm as a job runs it, without the settings this test runs under, which may include the ones checked.
  const npm = (dir: string, env: Record<string, string>, ...args: string[]) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_config_/i.test(k)));
    return spawnSync("npm", args, { cwd: dir, env: { ...clean, ...env } }).status;
  };
  // Every job in every workflow that installs or runs npm.
  const npmJobs = async () => {
    const jobs: [string, Job][] = [];
    const names = (await readdir(".github/workflows")).filter((f) => /\.ya?ml$/.test(f)).map((f) => f.replace(/\.ya?ml$/, ""));
    for (const name of names.sort()) {
      for (const [id, job] of Object.entries((await workflow(name)).jobs)) {
        const steps = job.steps ?? [];
        if (steps.some((s) => s.uses?.startsWith("actions/setup-node@") || /\bnp[mx]\b|check-(proof|refactor)\.sh/.test(s.run ?? ""))) {
          jobs.push([`${name}/${id}`, job]);
        }
      }
    }
    return jobs;
  };

  it("runs scripts with /bin/sh in every job that runs npm, whatever an .npmrc in the change says", async () => {
    const jobs = await npmJobs();
    expect(jobs.map(([id]) => id).sort()).toEqual(
      ["ci/answer-key", "ci/lint", "ci/package", "ci/test", "corpus/refresh", "golden/compare", "pr/proof", "pr/refactor", "publish/build", "publish/publish", "publish/verify"],
    );
    for (const [id, job] of jobs) expect(job.env?.npm_config_script_shell, id).toBe("/bin/sh");
    // npm reads npm_config_* variables after a project .npmrc, so the job's setting wins.
    const dir = await mkdtemp(join(tmpdir(), "darnit-npmrc-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", scripts: { t: "exit 3" } }));
    await writeFile(join(dir, "x.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(join(dir, ".npmrc"), "script-shell=./x.sh\n");
    const job = jobs.find(([id]) => id === "pr/refactor")![1].env!;
    expect(npm(dir, {}, "run", "t")).toBe(0);
    expect(npm(dir, job, "run", "t")).toBe(3);
    expect(npm(dir, job, "exec", "-c", "exit 3")).toBe(3);
  });

  it("skips install, pre and post scripts in the lint job, which needs none", async () => {
    const lint = (await workflow("ci")).jobs.lint!.env!;
    expect(lint.npm_config_ignore_scripts).toBe("true");
    const dir = await mkdtemp(join(tmpdir(), "darnit-npmrc-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", scripts: { prelint: "exit 3", lint: "exit 0" } }));
    expect(npm(dir, {}, "run", "lint")).toBe(3);
    expect(npm(dir, lint, "run", "lint")).toBe(0);
  });

  it("installs the change in the pull request jobs with no script of its own, then runs only the named dependency's", async () => {
    const jobs = (await workflow("pr")).jobs;
    const installs = ["refactor", "proof"].map((id) => jobs[id]!.steps!.find((s) => /\bnpm ci\b/.test(s.run ?? ""))!.run!);
    expect(installs[1]).toBe(installs[0]);
    const [ci, rebuild, ...rest] = installs[0]!.trim().split("\n");
    expect(rest).toEqual([]);
    const dir = await mkdtemp(join(tmpdir(), "darnit-install-"));
    tempDirs.push(dir);
    const log = (who: string) => `node -e "require('fs').appendFileSync('${join(dir, "log")}', '${who}\\n')"`;
    const scripts = Object.fromEntries(["preinstall", "install", "postinstall", "prepare"].map((s) => [s, log(s)]));
    const pkg = { name: "x", version: "1.0.0", scripts };
    await writeFile(join(dir, "package.json"), JSON.stringify(pkg));
    await writeFile(join(dir, "package-lock.json"), JSON.stringify({ name: "x", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": pkg } }));
    await writeFile(join(dir, "evil.cjs"), `require("fs").appendFileSync(${JSON.stringify(join(dir, "log"))}, "node-options\\n");\n`);
    await writeFile(join(dir, ".npmrc"), `node-options=--require ${join(dir, "evil.cjs")}\n`);
    const env = { ...jobs.refactor!.env!, npm_config_audit: "false", npm_config_fund: "false" };
    expect(npm(dir, env, ...ci!.split(" ").slice(1))).toBe(0);
    // What the lock would install: the dependency, with an install script of its own.
    await writeFile(join(dir, "package.json"), JSON.stringify({ ...pkg, dependencies: { "@ast-grep/cli": "1.0.0" } }));
    await mkdir(join(dir, "node_modules/@ast-grep/cli"), { recursive: true });
    await writeFile(join(dir, "node_modules/@ast-grep/cli/package.json"), JSON.stringify({ name: "@ast-grep/cli", version: "1.0.0", scripts: { postinstall: log("dependency") } }));
    expect(npm(dir, env, ...rebuild!.split(" ").slice(1))).toBe(0);
    expect(await readFile(join(dir, "log"), "utf8")).toBe("dependency\n");
  });
});

/** What a step wrote to $GITHUB_ENV or $GITHUB_OUTPUT, read as the runner reads it: NAME=value, or NAME<<END up to END. */
function commands(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const doc = /^([^=]+)<<(.+)$/.exec(line);
    if (doc) {
      const end = lines.indexOf(doc[2]!, i + 1);
      out[doc[1]!] = lines.slice(i + 1, end).join("\n");
      i = end;
    } else if (line.includes("=")) out[line.slice(0, line.indexOf("="))] = line.slice(line.indexOf("=") + 1);
  }
  return out;
}

/** `command` as the runner finds a step's shell: an absolute path that exists as it is, any other name on `path`. */
async function which(command: string, path: string) {
  for (const f of isAbsolute(command) ? [command] : path.split(delimiter).map((d) => join(d, command))) {
    if (await access(f, constants.X_OK).then(() => true, () => false)) return f;
  }
  throw new Error(`${command} is not on PATH`);
}

// The jobs below run side by side, so their folders go when the file is done.
const jobDirs: string[] = [];
afterAll(async () => {
  await Promise.all(jobDirs.map((d) => rm(d, { recursive: true, force: true })));
});

type PullRequest = { dir: string; base: string; head: string; title: string; decoy: string };

/**
 * Runs pr.yml's job `id` on `pr` as the runner would. Each run step gets the job's env, then what earlier steps
 * wrote to $GITHUB_ENV, then its own env, with the folders written to $GITHUB_PATH put before its PATH, and its
 * shell looked up on that PATH unless named by an absolute path. Action steps do nothing: the repo is the
 * checkout, and node is on PATH. The install has nothing to install, so this repo's node_modules stands in after
 * it. `after`, when given, runs right after the install, as code of the change would if it had run there. With
 * `event` merge_group there is no pull request, and the queued commits stand in for base and head.
 */
async function runJob(id: string, pr: PullRequest, after?: string, event = "pull_request") {
  const job = (await workflow("pr")).jobs[id]!;
  const temp = await mkdtemp(join(tmpdir(), "darnit-runner-"));
  jobDirs.push(temp);
  // A checkout of its own, as npm ci would empty the node_modules another run links in.
  const dir = join(temp, "checkout");
  execFileSync("git", ["worktree", "add", "-q", "--detach", dir, pr.head], { cwd: pr.dir });
  const files = { GITHUB_ENV: join(temp, "env"), GITHUB_PATH: join(temp, "path"), GITHUB_STEP_SUMMARY: join(temp, "summary") };
  for (const f of Object.values(files)) await writeFile(f, "");
  const outputs: Record<string, Record<string, string>> = {};
  const queued = event === "merge_group";
  const context: Record<string, string> = {
    "github.event_name": event,
    "github.event.pull_request.base.sha": queued ? "" : pr.base,
    "github.event.pull_request.head.sha": queued ? "" : pr.head,
    "github.event.pull_request.title": queued ? "" : pr.title,
    "github.event.pull_request.body": "",
    "github.event.merge_group.base_sha": queued ? pr.base : "",
    "github.event.merge_group.head_sha": queued ? pr.head : "",
  };
  // One value, or the first that is not empty of several joined by ||.
  const value = (expr: string): string => {
    if (expr.includes("||")) return expr.split("||").map((e) => value(e.trim())).find(Boolean) ?? "";
    const out = /^steps\.([\w-]+)\.outputs\.([\w-]+)$/.exec(expr);
    if (out) return outputs[out[1]!]?.[out[2]!] ?? "";
    if (expr in context) return context[expr]!;
    throw new Error(`no value for ${expr}`);
  };
  const expand = (s: string) => s.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_, e: string) => value(e));
  const vars = (env: Record<string, string> = {}) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, expand(String(v))]));
  const machine = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(npm_config_|GITHUB_|RUNNER_)/i.test(k))),
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  const steps = job.steps!.flatMap((s): Step[] => (after && /\bnpm ci\b/.test(s.run ?? "") ? [s, { ...s, run: after, shell: "/bin/sh -e {0}" }] : [s]));
  let log = "";
  for (const step of steps) {
    if (step.if) {
      const test = /^steps\.([\w-]+)\.outputs\.([\w-]+) == '([^']*)'$/.exec(step.if);
      if (!test) throw new Error(`no reading for if: ${step.if}`);
      if (outputs[test[1]!]?.[test[2]!] !== test[3]) continue;
    }
    if (!step.run) continue;
    const env: Record<string, string> = { ...machine, ...vars(job.env), ...commands(await readFile(files.GITHUB_ENV, "utf8")), ...vars(step.env) };
    const prepend = (await readFile(files.GITHUB_PATH, "utf8")).split("\n").filter(Boolean).reverse();
    const output = join(temp, "output");
    await writeFile(output, "");
    await writeFile(join(temp, "step"), expand(step.run));
    Object.assign(env, files, { PATH: [...prepend, env.PATH].join(delimiter), GITHUB_OUTPUT: output, RUNNER_TEMP: temp });
    const [shell, ...args] = (step.shell ?? "bash --noprofile --norc -eo pipefail {0}").split(" ");
    const child = spawn(await which(shell!, env.PATH!), args.map((a) => (a === "{0}" ? join(temp, "step") : a)), { cwd: dir, env });
    child.stdout.setEncoding("utf8").on("data", (d: string) => (log += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (log += d));
    const status = await new Promise<number | null>((done) => child.on("close", done));
    if (step.id) outputs[step.id] = commands(await readFile(output, "utf8"));
    if (status !== 0) return { status, ...(await verdict(temp)), log };
    if (/\bnpm ci\b/.test(step.run)) {
      await rm(join(dir, "node_modules"), { recursive: true, force: true });
      await symlink(resolve("node_modules"), join(dir, "node_modules"));
    }
  }
  return { status: 0, ...(await verdict(temp)), log };
}

/** The verdict lines of a job's summary, and whether breach.sh ran. */
const verdict = async (temp: string) => ({
  summary: (await readFile(join(temp, "summary"), "utf8")).split("\n").filter((l) => l.startsWith("**")),
  ran: await access(join(temp, "ran")).then(() => true, () => false),
});

const add = (op: string) => `export const add = (a: number, b: number) => a ${op} b;\n`;
const adds = (call: string, want: number) => `import { expect, it } from 'vitest';\nimport { add } from '../src/add.js';\nit('adds', () => expect(${call}).toBe(${want}));\n`;

/**
 * A pull request whose base holds the scripts pr.yml runs, a test and a stand-in fixture runner, and whose head
 * writes `head` and runs breach.sh on install, which writes a file `ran` and then does `breach`. A commit off base
 * beside head writes `decoy`; a breach that sets BASE points it there.
 */
async function pullRequest(title: string, head: Record<string, string>, decoy: Record<string, string>, breach: (decoy: string) => string) {
  const dir = await mkdtemp(join(tmpdir(), "darnit-pr-"));
  jobDirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" }).trim();
  const write = async (files: Record<string, string>) => {
    for (const [f, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, f)), { recursive: true });
      await writeFile(join(dir, f), text);
    }
  };
  const commit = (m: string) => (git("add", "-A"), git("commit", "-q", "-m", m), git("rev-parse", "HEAD"));
  const scripts = ["check-proof.sh", "check-proof.ts", "check-refactor.sh", "pr-common.sh"];
  git("init", "-q");
  await write({
    ".gitignore": "node_modules\n",
    "package.json": JSON.stringify({ name: "pr", type: "module" }),
    "package-lock.json": JSON.stringify({ name: "pr", lockfileVersion: 3, requires: true, packages: { "": { name: "pr" } } }),
    "vitest.config.ts": "export default {};\n",
    "src/add.ts": add("-"),
    "test/add.test.ts": adds("add(1, 0)", 1),
    "packs/v/p/change.json": "{}\n",
    "packs/v/p/rules/r.yml": "old\n",
    "packs/v/p/fixtures/basic/want": "old\n",
    "scripts/fixtures.ts": "export {};\n",
    ...Object.fromEntries(await Promise.all(scripts.map(async (s) => [`scripts/${s}`, await readFile(`scripts/${s}`, "utf8")] as const))),
  });
  const base = commit("base");
  await write(decoy);
  const sha = commit("decoy");
  git("checkout", "-q", base);
  await write({
    ...head,
    "package.json": JSON.stringify({ name: "pr", type: "module", scripts: { postinstall: "sh breach.sh" } }),
    "breach.sh": `: > "$RUNNER_TEMP/ran"\n${breach(sha)}`,
  });
  return { dir, base, head: commit("head"), title, decoy: sha };
}

// Each a change's install script could do; each runs on install, and again right after it as later code of the change would.
const breaches: Record<string, (decoy: string) => string> = {
  "rewrites the scripts the table step extracted to exit 0": () => `for f in "$RUNNER_TEMP"/scripts/*.sh; do echo 'exit 0' > "$f"; done\n`,
  "writes EVENT and BASE to $GITHUB_ENV": (decoy) => `printf 'EVENT=merge_group\\nBASE=%s\\n' ${decoy} >> "$GITHUB_ENV"\n`,
  "writes EVENT=merge_group to $GITHUB_ENV, so the scripts would take the merge queue pass": () => `echo EVENT=merge_group >> "$GITHUB_ENV"\n`,
  "puts a folder of fake git, sh, bash, node and npx first on $GITHUB_PATH": () =>
    `mkdir "$RUNNER_TEMP/fake"\nfor t in git sh bash node npx; do printf '#!/bin/sh\\nexit 0\\n' > "$RUNNER_TEMP/fake/$t"; chmod +x "$RUNNER_TEMP/fake/$t"; done\necho "$RUNNER_TEMP/fake" >> "$GITHUB_PATH"\n`,
};
// A change each job fails, and a decoy base it would pass on.
const cases = {
  refactor: { title: "refactor: add", head: { "src/add.ts": add("*") }, decoy: { "test/add.test.ts": adds("add(1, 0)", 0) }, fails: "**(b) failed:** a test from base fails" },
  proof: { title: "fix: add", head: { "src/add.ts": add("+"), "test/more.test.ts": adds("add(2, 0)", 2) }, decoy: { "src/add.ts": add("*") }, fails: "**Failed:** every changed test also passes" },
};

describe("the refactor and proof jobs", { timeout: 240_000 }, () => {
  for (const [id, c] of Object.entries(cases)) {
    it.concurrent(`${id}: fails the change, and passes it when base is the decoy`, async () => {
      const pr = await pullRequest(c.title, c.head, c.decoy, () => "");
      const [failed, passed] = await Promise.all([runJob(id, pr), runJob(id, { ...pr, base: pr.decoy })]);
      expect(failed.status, failed.log).toBe(1);
      expect(failed.summary.join("\n")).toContain(c.fails);
      expect(passed.status, passed.log).toBe(0);
    });
    for (const [what, breach] of Object.entries(breaches)) {
      it.concurrent(`${id}: judges the same when the change's code ${what}`, async () => {
        const pr = await pullRequest(c.title, c.head, c.decoy, breach);
        const [installed, after] = await Promise.all([runJob(id, pr), runJob(id, pr, "sh breach.sh")]);
        for (const r of [installed, after]) {
          expect(r.status, r.log).toBe(1);
          expect(r.summary.join("\n")).toContain(c.fails);
        }
        // No install script of the change runs.
        expect(installed.ran).toBe(false);
      });
    }
  }

  for (const id of Object.keys(cases)) {
    it.concurrent(`${id}: passes a merge queue run with the summary line, installing and running nothing of the change`, async () => {
      const c = cases[id as keyof typeof cases];
      const pr = await pullRequest(c.title, c.head, c.decoy, () => "");
      const r = await runJob(id, pr, undefined, "merge_group");
      expect(r.status, r.log).toBe(0);
      expect(r.log).toContain("Judged on the pull request; the merge queue admits only pull requests that passed it.");
      expect(r.summary).toEqual([]);
      expect(r.ran).toBe(false);
    });
  }

  it("takes no input the scripts trust from the job's env, and installs no change's scripts", async () => {
    for (const [id, job] of Object.entries((await workflow("pr")).jobs)) {
      expect(Object.keys(job.env ?? {}).filter((k) => ["EVENT", "BASE", "HEAD", "TITLE", "BODY", "PATH"].includes(k)), id).toEqual([]);
      for (const s of job.steps ?? []) if (/\bnpm ci\b/.test(s.run ?? "")) expect(s.run, id).toMatch(/\bnpm ci --ignore-scripts\b/);
    }
  });
});
