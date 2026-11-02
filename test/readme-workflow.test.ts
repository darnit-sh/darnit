import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { matchersAtDarnit } from "./helpers.js";

type Step = { uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, unknown>; "working-directory"?: string };
type Job = { needs?: string; if?: string; permissions?: unknown; env?: unknown; defaults?: unknown; steps: Step[] };

const read = (file: string) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const { version } = JSON.parse(await read("package.json")) as { version: string };

// The README's pull request workflow: --prepare in a job with no token, --publish in a job that runs none of the repository's code.
const block = [...(await read("README.md")).matchAll(/^```yaml\n([^]*?)^```$/gm)].map((m) => m[1]!).find((b) => /fix --publish/.test(b));
const workflow = () => {
  if (!block) throw new Error("README has no workflow that runs fix --publish");
  return parse(block) as { env?: unknown; jobs: { prepare: Job; publish: Job } };
};
const jobs = () => workflow().jobs;
const runs = (job: Job) => job.steps.flatMap((s) => (s.run ? [s.run] : []));
const matchersOnly = (run: string) => /^(?:echo "::remove-matcher owner=[\w-]+::"\n?)+$/.test(run);
const install = () => jobs().publish.steps.find((s) => s.run?.includes("npm pack"));

describe("the README's two-job fix workflow", () => {
  it("has exactly a prepare job and a publish job that waits for it", () => {
    const { jobs } = workflow();
    expect(Object.keys(jobs)).toEqual(["prepare", "publish"]);
    expect(jobs.publish.needs).toBe("prepare");
  });

  it("gives the prepare job a read-only token that the checkout does not keep, and no token anywhere else", () => {
    const { env, jobs } = workflow();
    expect(jobs.prepare.permissions).toEqual({ contents: "read" });
    const checkouts = jobs.prepare.steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]!.with?.["persist-credentials"]).toBe(false);
    expect(JSON.stringify([env, jobs.prepare])).not.toMatch(/GITHUB_TOKEN|GH_TOKEN|github\.token|secrets\./);
  });

  it("runs the pinned darnit from $RUNNER_TEMP in the prepare job and uploads the plan, even when a change fails its tests", () => {
    const { prepare, publish } = jobs();
    expect(runs(prepare).filter((r) => /darnit/.test(r))).toEqual([`cd "\${RUNNER_TEMP:?}" && npx darnit@${version} fix --prepare "\${RUNNER_TEMP:?}/plan" "\${GITHUB_WORKSPACE:?}"`]);
    const upload = prepare.steps.at(-1)!;
    expect(upload.uses).toMatch(/^actions\/upload-artifact@/);
    expect(upload.with).toEqual({ name: "darnit-plan", path: "${{ runner.temp }}/plan", "if-no-files-found": "error" });
    // A change that fails exits 1 after writing the plan; the others still get their pull requests, as with --pr.
    expect(upload.if).toBe("${{ !cancelled() }}");
    expect(publish.if).toBe("${{ !cancelled() }}");
    const download = publish.steps.find((s) => s.uses?.startsWith("actions/download-artifact@"));
    expect(download?.with).toEqual({ name: "darnit-plan", path: "${{ runner.temp }}/plan" });
  });

  it("names the version in package.json everywhere it names a darnit version, comments included", () => {
    workflow();
    const named = [...block!.matchAll(/\bdarnit[@-](\d[\w.-]*?)(?=\.tgz\b|[\s`"])/g)].map((m) => m[1]);
    expect(named).toEqual(Array(5).fill(version));
  });

  it("never checks out, installs or runs the repository in the job that holds the write token", () => {
    const { publish } = jobs();
    expect(publish.permissions).toEqual({ contents: "write", "pull-requests": "write" });
    expect(publish.steps.map((s) => s.uses?.split("@")[0]).filter(Boolean)).toEqual(["actions/setup-node", "actions/download-artifact"]);
    expect(JSON.stringify(publish)).not.toMatch(/GITHUB_WORKSPACE|github\.workspace|working-directory|\bnpx\b|\bnpm ci\b/);
    expect(publish.defaults).toBeUndefined();
    for (const run of runs(publish)) {
      if (!matchersOnly(run)) expect(run).toMatch(/^cd "\$\{RUNNER_TEMP:\?\}"(?: &&|\n)/);
    }
    expect(runs(publish).flatMap((r) => r.match(/\bnpm install\b.*/g) ?? [])).toEqual([`npm install ./darnit-${version}.tgz`]);
    expect(runs(publish).at(-1)).toBe('cd "${RUNNER_TEMP:?}" && darnit/node_modules/.bin/darnit fix --publish plan');
    expect(publish.steps.at(-1)!.env).toEqual({ GITHUB_TOKEN: "${{ github.token }}" });
  });

  it("installs the publishing darnit by exact version into a new folder and stops unless its checksum is the one written in the workflow", () => {
    const step = install()!;
    // One && chain, so a failed check, or a darnit folder already there, stops what follows without bash -e.
    expect(step.run!.trimEnd().split(/ &&\n */)).toEqual([
      'cd "${RUNNER_TEMP:?}"',
      "mkdir darnit",
      "cd darnit",
      // Its own package.json, so npm looks for no .npmrc in the folders above.
      "echo '{}' > package.json",
      `npm pack darnit@${version}`,
      `test "sha512-$(openssl dgst -sha512 -binary darnit-${version}.tgz | base64 -w0)" = "\${INTEGRITY:?}"`,
      `npm install ./darnit-${version}.tgz`,
    ]);
    // Nothing that lets the step go on past a failure or runs it under another shell.
    expect(Object.keys(step).sort()).toEqual(["env", "run"]);
    expect(workflow()).not.toHaveProperty("defaults");
    // The expected checksum is written in the workflow, never read from npm or the plan; empty, the step stops.
    expect(typeof step.env?.INTEGRITY).toBe("string");
    expect(step.env!.INTEGRITY).not.toMatch(/\$/);
  });

  it("reads no user .npmrc and no npm cache an earlier job could have left", () => {
    const { env, jobs } = workflow();
    expect(install()!.env).toMatchObject({ NPM_CONFIG_USERCONFIG: "/dev/null", NPM_CONFIG_CACHE: "${{ runner.temp }}/npm-cache" });
    expect(Object.keys(install()!.env!).sort()).toEqual(["INTEGRITY", "NPM_CONFIG_CACHE", "NPM_CONFIG_USERCONFIG"]);
    expect(JSON.stringify([env, jobs.publish.env])).not.toMatch(/npm_config/i);
  });

  it("removes setup-node's problem matchers before darnit runs in each job", () => {
    const { prepare, publish } = jobs();
    expect(matchersAtDarnit(prepare.steps)).toEqual([]);
    // matchersAtDarnit finds darnit by `npx darnit`; the publish job runs it from node_modules/.bin.
    const fromBin = publish.steps.map((s) => (s.run ? { ...s, run: s.run.replace(/\S*\/\.bin\/darnit\b/, "npx darnit") } : s));
    expect(matchersAtDarnit(fromBin)).toEqual([]);
  });
});
