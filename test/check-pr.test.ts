import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

type Step = { run?: string };
const workflow = parse(await readFile(".github/workflows/pr.yml", "utf8")) as { jobs: { title: { steps: Step[] } } };
const step = workflow.jobs.title.steps.find((s) => s.run)!.run!;
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
