import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Defaults = { defaults?: { run?: { shell?: string } } };
type Step = { run?: string; shell?: string };
type Workflow = Defaults & { jobs?: Record<string, Defaults & { steps?: Step[] }> };
type Workflows = Record<string, Workflow>;

const DIR = new URL("../.github/workflows/", import.meta.url);
const ours = async (): Promise<Workflows> => {
  const files = (await readdir(DIR)).filter((f) => /\.ya?ml$/.test(f));
  return Object.fromEntries(
    await Promise.all(
      files.map(async (f): Promise<[string, Workflow]> => [
        f,
        parse(await readFile(new URL(f, DIR), "utf8")) as Workflow,
      ]),
    ),
  );
};

// GitHub runs `shell: bash` as `bash --noprofile --norc -eo pipefail {0}`; with no shell named it runs `bash -e {0}`,
// where a pipe's exit status is its last command's, so `npm run corpus | tee log` passes when npm run corpus fails.
const PIPEFAIL_SHELL = /^bash$|-\w*o\s+pipefail\b/;
const SET_PIPEFAIL = /^[ \t]*set[ \t]+-\w*o[ \t]+pipefail\b/m;
const PIPE = /(?<!\|)\|(?!\|)/;

/** The script without GitHub expressions and single-quoted text, so a | left in it is the shell's. */
const shellText = (run: string) =>
  run
    .replace(/\$\{\{[\s\S]*?\}\}/g, "")
    .replace(/"(?:\\[\s\S]|[^"\\])*"|'[^']*'/g, (quoted) => (quoted.startsWith("'") ? "''" : quoted));

/** Every step of every job, with the shell it runs under and where it sits. */
const steps = (workflows: Workflows) =>
  Object.entries(workflows).flatMap(([file, workflow]) =>
    Object.entries(workflow.jobs ?? {}).flatMap(([name, job]) =>
      (job.steps ?? []).flatMap((step, i) =>
        step.run === undefined
          ? []
          : [
              {
                at: `${file} job ${name} step ${i + 1} (${step.run.trim().split("\n")[0]})`,
                run: step.run,
                shell: step.shell ?? job.defaults?.run?.shell ?? workflow.defaults?.run?.shell,
              },
            ],
      ),
    ),
  );

/** Each step that pipes commands under a shell that passes when a command before the last one fails. */
function unguarded(workflows: Workflows): string[] {
  return steps(workflows)
    .filter(
      ({ run, shell }) => PIPE.test(shellText(run)) && !PIPEFAIL_SHELL.test(shell ?? "") && !SET_PIPEFAIL.test(run),
    )
    .map(({ at, shell }) => `${at} pipes under ${shell ?? "the default bash -e"}, without pipefail`);
}

/**
 * Each line that pipes inside $(...) and hands the output to another command: the line's exit status is that
 * command's, so even pipefail lets the pipe fail unseen. A line that only assigns the output fails with it.
 */
function hiddenInArgument(workflows: Workflows): string[] {
  return steps(workflows).flatMap(({ at, run }) =>
    shellText(run)
      .split("\n")
      .filter((line) => /\$\(.*(?<!\|)\|(?!\|)/.test(line) && !/^\s*\w+=\$\(/.test(line))
      .map((line) => `${at}: ${line.trim()}`),
  );
}

/** One workflow with one job running `run`, under `shell` named on the workflow, the job or the step. */
const one = (run: string, shell?: { on: "workflow" | "job" | "step"; is: string }): Workflows => {
  const named = (on: string) => (shell?.on === on ? { shell: shell.is } : {});
  const defaults = (on: string) => (shell?.on === on ? { defaults: { run: { shell: shell.is } } } : {});
  return {
    "a.yml": { ...defaults("workflow"), jobs: { j: { ...defaults("job"), steps: [{ run, ...named("step") }] } } },
  };
};
const STEP = "a.yml job j step 1";

describe("the workflows' pipes", () => {
  it("fail the step when any command in them fails", async () => {
    expect(unguarded(await ours())).toEqual([]);
    expect(hiddenInArgument(await ours())).toEqual([]);
  });

  it("fail corpus.yml's steps, and name them, without pipefail or with the count passed to echo", async () => {
    const workflows = structuredClone(await ours());
    delete workflows["corpus.yml"]!.defaults;
    expect(unguarded(workflows)).toEqual([
      'corpus.yml job refresh step 5 (npm run corpus | tee "$RUNNER_TEMP/corpus.log") pipes under the default bash -e, without pipefail',
      "corpus.yml job refresh step 6 (count=$(git status --porcelain | wc -l)) pipes under the default bash -e, without pipefail",
    ]);
    workflows["corpus.yml"]!.defaults = { run: { shell: "bash" } };
    const count = workflows["corpus.yml"]!.jobs!.refresh!.steps![5]!;
    count.run = 'echo "count=$(git status --porcelain | wc -l)" >> "$GITHUB_OUTPUT"';
    expect(hiddenInArgument(workflows)).toEqual([`corpus.yml job refresh step 6 (${count.run}): ${count.run}`]);
  });

  it("take shell: bash from the workflow, the job or the step, and a step's own shell over it", () => {
    for (const on of ["workflow", "job", "step"] as const)
      expect(unguarded(one("a | b", { on, is: "bash" }))).toEqual([]);
    for (const is of ["bash -e {0}", "bash {0}", "sh", "/bin/sh -e {0}"])
      expect(unguarded(one("a | b", { on: "step", is }))).toEqual([
        `${STEP} (a | b) pipes under ${is}, without pipefail`,
      ]);
    expect(unguarded(one("a | b", { on: "step", is: "bash --noprofile --norc -eo pipefail {0}" }))).toEqual([]);
    const workflows = one("a | b", { on: "workflow", is: "bash" });
    workflows["a.yml"]!.jobs!.j!.steps![0]!.shell = "sh -e {0}";
    expect(unguarded(workflows)).toEqual([`${STEP} (a | b) pipes under sh -e {0}, without pipefail`]);
  });

  it("take set -o pipefail in the step, but not in a comment", () => {
    for (const set of ["set -o pipefail", "set -eo pipefail", "  set -euo pipefail"])
      expect(unguarded(one(`${set}\na | b`))).toEqual([]);
    expect(unguarded(one("# set -o pipefail\na | b"))).toHaveLength(1);
  });

  it("count a pipe in double quotes or after an apostrophe, and not || or a | in single quotes or an expression", () => {
    for (const run of ['echo "n=$(a | wc -l)"', `printf "base's\\n" | tee x`, "a |& b", "a|b"])
      expect(unguarded(one(run))).toHaveLength(1);
    for (const run of ["a || b", "grep -E 'a|b' f", "echo ${{ x || 'y|z' }}", "echo 'it''s|'"])
      expect(unguarded(one(run))).toEqual([]);
  });

  it("fail a pipe inside $(...) whose output goes to another command, and not one that is only assigned", () => {
    const run = 'echo "count=$(git status --porcelain | wc -l)" >> "$GITHUB_OUTPUT"';
    expect(hiddenInArgument(one(run, { on: "workflow", is: "bash" }))).toEqual([`${STEP} (${run}): ${run}`]);
    expect(hiddenInArgument(one("count=$(git status --porcelain | wc -l)\necho $count"))).toEqual([]);
    expect(hiddenInArgument(one("n=$(grep -c 'a|b' f || true) && echo \"$(date)\""))).toEqual([]);
  });
});
