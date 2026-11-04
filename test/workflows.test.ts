import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

type Job = { "timeout-minutes"?: unknown; uses?: string; if?: unknown; name?: unknown; env?: Record<string, string>; strategy?: { matrix?: unknown } };
type Workflow = { on?: unknown; jobs?: Record<string, Job>; concurrency?: { group?: unknown } };
type Workflows = Record<string, Workflow>;

// The workflows main's required checks come from (golden.yml's check runs inside ci.yml's run).
// A merge queue waits for the same checks, so each must also run on merge_group.
const REQUIRED = ["ci.yml", "pr.yml"];
const LOCAL = "./.github/workflows/";
// GitHub stops a job on its own runners after 360 minutes whatever the limit says.
const MAX_MINUTES = 360;
// A matrix exclude that only drops entries on a pull request, so a merge queue run has every check a pull request has.
const PR_ONLY = /^\$\{\{ github\.event_name == 'pull_request' && fromJSON\('.*'\) \|\| fromJSON\('\[\]'\) \}\}$/;

const DIR = new URL("../.github/workflows/", import.meta.url);
const ours = async (): Promise<Workflows> => {
  const files = (await readdir(DIR)).filter((f) => /\.ya?ml$/.test(f));
  return Object.fromEntries(await Promise.all(files.map(async (f): Promise<[string, Workflow]> => [f, parse(await readFile(new URL(f, DIR), "utf8")) as Workflow])));
};
// A deep copy of the real workflows, so a breach changes nothing the next test reads.
const copy = async (): Promise<Workflows> => structuredClone(await ours());

// The events a workflow runs on, in each form `on:` takes: one name, a list, or a map.
const events = (on: unknown): string[] => {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  return on && typeof on === "object" ? Object.keys(on) : [];
};
const readsEvent = (v: unknown) => v !== undefined && /event_name|github\.event\b|merge_group/.test(JSON.stringify(v));

/** What is wrong with one job: a job that runs has a limit, and a job that calls a workflow names one this repository holds. */
function jobProblem(workflows: Workflows, at: string, job: Job): string | undefined {
  const limit = job["timeout-minutes"];
  if (job.uses === undefined) {
    if (typeof limit === "number" && Number.isInteger(limit) && limit > 0 && limit <= MAX_MINUTES) return undefined;
    return `${at} has no timeout-minutes from 1 to ${MAX_MINUTES} (it reads ${JSON.stringify(limit)})`;
  }
  // GitHub refuses timeout-minutes on a job that calls a workflow; the called workflow's own jobs carry the limits.
  if (limit !== undefined) return `${at} calls a workflow, where GitHub does not accept timeout-minutes`;
  const called = job.uses;
  if (!called.startsWith(LOCAL)) return `${at} calls ${called}, whose jobs' time limits this test cannot read`;
  if (!(called.slice(LOCAL.length) in workflows)) return `${at} calls ${called}, which is not in .github/workflows`;
  return undefined;
}

/** What could drop a required check, or change its name, between a pull request run and a merge queue run. */
function eventBound(at: string, job: Job): string[] {
  const found = readsEvent(job.if) || readsEvent(job.name) ? [`${at} has an if or name that depends on the event`] : [];
  const matrix = job.strategy?.matrix;
  if (typeof matrix === "string") return [...found, `${at} matrix can differ between events`];
  for (const [axis, values] of Object.entries(matrix ?? {})) {
    const fine = axis === "exclude" && typeof values === "string" ? PR_ONLY.test(values) : !readsEvent(values);
    if (!fine) found.push(`${at} matrix ${axis} can differ between events`);
  }
  return found;
}

/** Every rule these workflows break, one line each. */
function problems(workflows: Workflows): string[] {
  const found = Object.entries(workflows).flatMap(([file, workflow]) =>
    Object.entries(workflow.jobs ?? {}).map(([name, job]) => jobProblem(workflows, `${file} job ${name}`, job)),
  );
  for (const file of REQUIRED) {
    if (!events(workflows[file]?.on).includes("merge_group")) found.push(`${file} gives required checks but does not run on merge_group`);
    const jobs = Object.entries(workflows[file]?.jobs ?? {});
    const called = jobs.map(([, job]) => job.uses ?? "").filter((u) => u.startsWith(LOCAL)).map((u) => u.slice(LOCAL.length));
    for (const f of [file, ...called]) found.push(...Object.entries(workflows[f]?.jobs ?? {}).flatMap(([name, job]) => eventBound(`${f} job ${name}`, job)));
  }
  return found.filter((p) => p !== undefined);
}

describe("the workflows in .github/workflows", () => {
  it("give every job a time limit and run every required check, under the same name, for the merge queue", async () => {
    expect(problems(await ours())).toEqual([]);
  });

  it("fail a new job without timeout-minutes, or with a limit GitHub would not keep", async () => {
    for (const limit of [undefined, 0, -5, 2.5, 361, "15", "${{ inputs.minutes }}"]) {
      const workflows = await copy();
      workflows["corpus.yml"]!.jobs!.extra = { "timeout-minutes": limit };
      expect(problems(workflows)).toEqual([`corpus.yml job extra has no timeout-minutes from 1 to 360 (it reads ${JSON.stringify(limit)})`]);
    }
  });

  it("fail a job that calls a workflow with timeout-minutes, a workflow outside this repository, or one that is missing", async () => {
    const workflows = await copy();
    workflows["ci.yml"]!.jobs!.golden!["timeout-minutes"] = 45;
    workflows["publish.yml"]!.jobs!.remote = { uses: "octo/repo/.github/workflows/x.yml@main" };
    workflows["publish.yml"]!.jobs!.gone = { uses: "./.github/workflows/gone.yml" };
    expect(problems(workflows)).toEqual([
      "ci.yml job golden calls a workflow, where GitHub does not accept timeout-minutes",
      "publish.yml job remote calls octo/repo/.github/workflows/x.yml@main, whose jobs' time limits this test cannot read",
      "publish.yml job gone calls ./.github/workflows/gone.yml, which is not in .github/workflows",
    ]);
  });

  it("fail a called workflow whose job has no limit, on that workflow's own line", async () => {
    const workflows = await copy();
    delete workflows["golden.yml"]!.jobs!.compare!["timeout-minutes"];
    expect(problems(workflows)).toEqual(["golden.yml job compare has no timeout-minutes from 1 to 360 (it reads undefined)"]);
  });

});

describe("the workflows in a merge queue", () => {
  it("fail a required workflow without merge_group, in each form on: takes", async () => {
    for (const on of ["pull_request", ["push", "pull_request"], { push: { branches: ["main"] }, pull_request: null }, undefined]) {
      const workflows = await copy();
      workflows["ci.yml"]!.on = on;
      expect(problems(workflows)).toEqual(["ci.yml gives required checks but does not run on merge_group"]);
    }
    const missing = await copy();
    delete missing["pr.yml"];
    expect(problems(missing)).toEqual(["pr.yml gives required checks but does not run on merge_group"]);
    for (const on of ["merge_group", ["merge_group"], { merge_group: null }]) expect(events(on)).toEqual(["merge_group"]);
  });

  it("fail a required check that a merge queue run would skip, rename or leave out", async () => {
    const workflows = await copy();
    workflows["pr.yml"]!.jobs!.title!.if = "github.event_name == 'pull_request'";
    workflows["ci.yml"]!.jobs!.lint!.name = "lint on ${{ github.event_name }}";
    workflows["golden.yml"]!.jobs!.compare!.if = "github.event.pull_request";
    workflows["ci.yml"]!.jobs!.test!.strategy!.matrix = { os: ["ubuntu-latest"], exclude: "${{ github.event_name == 'merge_group' && fromJSON('[{\"os\":\"ubuntu-latest\"}]') || fromJSON('[]') }}" };
    workflows["ci.yml"]!.jobs!.package!.strategy!.matrix = "${{ fromJSON(github.event_name) }}";
    expect(problems(workflows)).toEqual([
      "ci.yml job lint has an if or name that depends on the event",
      "ci.yml job test matrix exclude can differ between events",
      "ci.yml job package matrix can differ between events",
      "golden.yml job compare has an if or name that depends on the event",
      "pr.yml job title has an if or name that depends on the event",
    ]);
  });

  it("hand each step that runs a pull request check the event and, in a merge queue, the queued commits", async () => {
    const pr = (await ours())["pr.yml"]!;
    type Step = { run?: string; env?: Record<string, string> };
    const steps = Object.values(pr.jobs ?? {}).flatMap((job) => (job as { steps: Step[] }).steps);
    const checks = steps.filter((s) => /scripts\/check-/.test(s.run ?? ""));
    expect(checks).toHaveLength(5);
    for (const { env } of checks) {
      expect(env).toMatchObject({ EVENT: "${{ github.event_name }}", BASE: "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}" });
      if (env?.HEAD !== undefined) expect(env.HEAD).toBe("${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}");
    }
    expect(pr.concurrency?.group).toBe("${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}");
  });
});

const temps: string[] = [];
afterAll(() => Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))));
const QUEUED = "Judged on the pull request; the merge queue admits only pull requests that passed it.";
const NONE = "0".repeat(40);

/** A repository whose head commit writes `edits` over a base holding src/a.ts and test/a.test.ts. */
async function repo(edits: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "darnit-queue-"));
  temps.push(dir);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" }).trim();
  const commit = async (files: Record<string, string>, subject: string) => {
    for (const [f, text] of Object.entries(files)) await writeFile(join(dir, f), text);
    git("add", ".");
    git("commit", "-q", "-m", subject);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  execFileSync("mkdir", ["src", "test"], { cwd: dir });
  const base = await commit({ "src/a.ts": "export const a = 1;\n", "test/a.test.ts": "// a\n" }, "ci: base");
  return { dir, base, head: await commit(edits, "ci: head") };
}

/** A pull request check script run in `dir` with `env` over the runner's, and what it wrote. */
async function run(dir: string, args: string[], env: Record<string, string>) {
  const summary = join(dir, ".git", "summary");
  const output = join(dir, ".git", "output");
  await Promise.all([writeFile(summary, ""), writeFile(output, "")]);
  const r = spawnSync("sh", [resolve("scripts", args[0]!), ...args.slice(1)], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, EVENT: "", AUTHOR: "someone", BODY: "", ...env, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output },
  });
  return { status: r.status, stdout: r.stdout, summary: await readFile(summary, "utf8"), output: await readFile(output, "utf8") };
}

describe("the pull request checks", () => {
  it("still fail a bad title, a refactor that edits a test and a fix with no failing test on a pull request", async () => {
    const edited = await repo({ "test/a.test.ts": "// b\n" });
    const code = await repo({ "src/a.ts": "export const a = 2;\n" });
    const cases = [
      [edited, "check-pr.sh", "bad title", "::error::title is not type(scope): summary: bad title"],
      [edited, "check-refactor.sh", "refactor: tidy", "**(a) failed:**"],
      [code, "check-proof.sh", "fix: two", "**Failed:** no new or changed test"],
    ] as const;
    // The runner's own event name never stands in for EVENT, which the workflow sets for these checks alone.
    for (const EVENT of ["pull_request", "", "merge_group "]) {
      for (const [r, script, TITLE, text] of cases) {
        const { status, stdout } = await run(r.dir, [script, r.base, r.head], { EVENT, GITHUB_EVENT_NAME: "merge_group", TITLE });
        expect(stdout).toContain(text);
        expect(status).toBe(1);
      }
    }
  });

  it("pass in a merge queue with one summary line, reading and changing nothing", async () => {
    const { dir } = await repo({ "test/a.test.ts": "// b\n" });
    const forms = [["check-pr.sh"], ["check-refactor.sh"], ["check-refactor.sh", "--base-tests"], ["check-proof.sh"], ["check-proof.sh", "--run"]];
    for (const form of forms) {
      // Shas that name nothing and an empty title: any pull request logic that ran would fail.
      const r = await run(dir, [...form, NONE, NONE], { EVENT: "merge_group", TITLE: "" });
      expect(r).toEqual({ status: 0, stdout: `${QUEUED}\n`, summary: `${QUEUED}\n\n`, output: "" });
    }
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toBe("");
  });
});
