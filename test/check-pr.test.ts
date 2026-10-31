import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

type Step = { run?: string; uses?: string };
type Job = { env?: Record<string, string>; steps?: Step[] };
const workflow = async (name: string) =>
  parse(await readFile(`.github/workflows/${name}.yml`, "utf8")) as { jobs: Record<string, Job> };
const step = (await workflow("pr")).jobs.title!.steps!.find((s) => s.run)!.run!;
const checker = await readFile("scripts/check-pr.sh", "utf8");

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
      ["ci/lint", "ci/package", "ci/test", "corpus/refresh", "golden/compare", "pr/proof", "pr/refactor", "publish/build", "publish/publish", "publish/verify"],
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
});
