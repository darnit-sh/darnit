import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { minutesOn } from "./helpers.js";

type Job = { "timeout-minutes"?: unknown; uses?: string; "runs-on"?: string; strategy?: { matrix?: { os?: string[] } } };
type Workflows = Record<string, { jobs?: Record<string, Job> }>;

// The slowest of each job's latest successful runs, in seconds (completed minus started, as the API reports it):
// 12 ci.yml runs (all six test and package entries on main, macOS on Node 22 only on pull requests), 4 pr.yml runs
// and 3 corpus.yml runs.
const SLOWEST: Record<string, number> = {
  "ci.yml lint": 79,
  "ci.yml test ubuntu-latest": 581,
  "ci.yml test macos-latest": 533,
  "ci.yml package ubuntu-latest": 96,
  "ci.yml package macos-latest": 122,
  "pr.yml title": 10,
  "corpus.yml refresh": 455,
  "corpus.yml open-pr": 18,
};
// Jobs whose slow path no sampled run took, with the limit each keeps and why.
const UNMEASURED: Record<string, [number, string]> = {
  "ci.yml answer-key": [45, "reads golden's cached clones; after repos.tsv changes it clones every pinned repository, which no sampled run did"],
  "golden.yml compare": [45, "after repos.tsv changes it clones every pinned repository, which no sampled run did"],
  "pr.yml refactor": [20, "no sampled run reached its base tests, which run the whole suite (twice ci.yml's slowest test run), or its style step, which formats the changed files once"],
  "pr.yml proof": [20, "no sampled run reached its test runs, which run the changed tests twice"],
  "publish.yml build": [30, "never run; it runs npm run check, about ci.yml's slowest test and lint runs together, doubled"],
  "publish.yml publish": [10, "never run; it installs npm and publishes one tarball"],
  "publish.yml verify": [15, "never run; scripts/verify-release.sh waits up to 5 minutes for npm, doubled"],
};
// A job waiting for a runner counts toward its limit: three macOS test jobs were cancelled 15m02s after they were
// queued, at their 15 minute limit, with no runner and no step run. The longest wait seen was cut off there, so
// macOS jobs get twice that on top.
const MACOS_QUEUE = 30;
// The merge queue's status check timeout in the ruleset, which every required job's limit must stay under.
const STATUS_CHECK_TIMEOUT = 60;
const REQUIRED = ["ci.yml", "pr.yml", "golden.yml"];

const DIR = new URL("../.github/workflows/", import.meta.url);
const ours = async (): Promise<Workflows> => {
  const files = (await readdir(DIR)).filter((f) => /\.ya?ml$/.test(f));
  return Object.fromEntries(await Promise.all(files.map(async (f): Promise<[string, Workflows[string]]> => [f, parse(await readFile(new URL(f, DIR), "utf8")) as Workflows[string]])));
};

/** Twice the slowest run, rounded up to whole 5 minutes, and never under 5. */
const measured = (seconds: number) => Math.max(5, Math.ceil((2 * seconds) / 300) * 5);
const runners = (job: Job) => (job["runs-on"] === "${{ matrix.os }}" ? (job.strategy?.matrix?.os ?? []) : [job["runs-on"] ?? ""]);

/** Every job, on every runner it runs on, whose limit differs from what its measured runs or stated reason set. */
function unmeasured(workflows: Workflows): string[] {
  const found: string[] = [];
  const entries = Object.entries(workflows).flatMap(([file, workflow]) =>
    Object.entries(workflow.jobs ?? {})
      .filter(([, job]) => job.uses === undefined)
      .flatMap(([name, job]) => runners(job).map((os) => ({ at: `${file} ${name}`, os, limit: minutesOn(job["timeout-minutes"], os) }))),
  );
  for (const { at, os, limit } of entries) {
    const seconds = SLOWEST[`${at} ${os}`] ?? SLOWEST[at];
    const want = seconds === undefined ? UNMEASURED[at]?.[0] : measured(seconds) + (os === "macos-latest" ? MACOS_QUEUE : 0);
    const job = at.replace(" ", " job ");
    if (want === undefined) found.push(`${job} on ${os} has no measured run time or stated reason`);
    else if (limit !== want) found.push(`${job} on ${os} has a limit of ${String(limit)} minutes; its runs set ${want}`);
  }
  return found;
}

/** Each required job, on each runner, whose limit a merge queue would not wait out before calling its check failed. */
function pastStatusTimeout(workflows: Workflows): string[] {
  return REQUIRED.flatMap((file) =>
    Object.entries(workflows[file]?.jobs ?? {})
      .filter(([, job]) => job.uses === undefined)
      .flatMap(([name, job]) => runners(job).map((os) => [`${file} job ${name} on ${os}`, minutesOn(job["timeout-minutes"], os) ?? Infinity] as const))
      .filter(([, minutes]) => minutes >= STATUS_CHECK_TIMEOUT)
      .map(([at, minutes]) => `${at} may run ${minutes} minutes, not under the ${STATUS_CHECK_TIMEOUT} minute status check timeout`),
  );
}

describe("the workflows' time limits", () => {
  it("are twice each job's slowest measured run, rounded up to 5 minutes, or a stated reason's", async () => {
    expect(unmeasured(await ours())).toEqual([]);
    expect([79, 300, 301, 581].map(measured)).toEqual([5, 10, 15, 20]);
  });

  it("fail a new job, and a limit below or well above what its runs set", async () => {
    const workflows = structuredClone(await ours());
    workflows["corpus.yml"]!.jobs!.extra = { "runs-on": "ubuntu-latest", "timeout-minutes": 5 };
    workflows["ci.yml"]!.jobs!.lint!["timeout-minutes"] = 15;
    workflows["corpus.yml"]!.jobs!.refresh!["timeout-minutes"] = 10;
    expect(unmeasured(workflows)).toEqual([
      "ci.yml job lint on ubuntu-latest has a limit of 15 minutes; its runs set 5",
      "corpus.yml job refresh on ubuntu-latest has a limit of 10 minutes; its runs set 20",
      "corpus.yml job extra on ubuntu-latest has no measured run time or stated reason",
    ]);
  });

  it("give macOS jobs room for the wait for a runner, and fail one without it", async () => {
    const workflows = structuredClone(await ours());
    expect(minutesOn(workflows["ci.yml"]!.jobs!.test!["timeout-minutes"], "macos-latest")).toBe(measured(533) + MACOS_QUEUE);
    workflows["ci.yml"]!.jobs!.test!["timeout-minutes"] = 20;
    expect(unmeasured(workflows)).toEqual(["ci.yml job test on macos-latest has a limit of 20 minutes; its runs set 50"]);
  });

  it("stay under the merge queue's status check timeout for every required job, and fail one that does not", async () => {
    expect(pastStatusTimeout(await ours())).toEqual([]);
    const workflows = structuredClone(await ours());
    workflows["golden.yml"]!.jobs!.compare!["timeout-minutes"] = 60;
    workflows["pr.yml"]!.jobs!.title!["timeout-minutes"] = "${{ inputs.minutes }}";
    expect(pastStatusTimeout(workflows)).toEqual([
      "pr.yml job title on ubuntu-latest may run Infinity minutes, not under the 60 minute status check timeout",
      "golden.yml job compare on ubuntu-latest may run 60 minutes, not under the 60 minute status check timeout",
    ]);
  });
});
