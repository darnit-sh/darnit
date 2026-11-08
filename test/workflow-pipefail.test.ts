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
// The only steps that may name another shell, by job and last line: they run base's scripts and name /bin/sh by
// path, as earlier steps there can change PATH. sh has no pipefail, so they must hold no |.
const SH = "/bin/sh -e {0}";
const OTHER_SHELL: Record<string, string> = {
  'pr.yml job refactor: /bin/sh "$dir/scripts/check-refactor.sh" --base-tests "$BASE"': SH,
  'pr.yml job refactor: /bin/sh "$dir/scripts/check-refactor.sh" --style "$BASE" "$HEAD"': SH,
  'pr.yml job proof: /bin/sh "$dir/scripts/check-proof.sh" --run "$BASE" "$HEAD"': SH,
};
const PIPE = /(?<!\|)\|(?!\|)/;

/** Every step that runs a script, with where it sits, its key in OTHER_SHELL and the shell it names. */
const steps = (workflows: Workflows) =>
  Object.entries(workflows).flatMap(([file, workflow]) =>
    Object.entries(workflow.jobs ?? {}).flatMap(([name, job]) =>
      (job.steps ?? []).flatMap(({ run, shell }, i) => {
        if (run === undefined) return [];
        const lines = run.trim().split("\n");
        const at = `${file} job ${name} step ${i + 1} (${lines[0]})`;
        return [{ at, key: `${file} job ${name}: ${lines.at(-1)!.trim()}`, run, shell }];
      }),
    ),
  );

/** Each workflow without bash as its default shell, each job naming another, and each step naming one not listed. */
function shells(workflows: Workflows): string[] {
  const found = Object.entries(workflows).flatMap(([file, workflow]) => [
    ...(workflow.defaults?.run?.shell === "bash" ? [] : [`${file} does not set bash as its default shell`]),
    ...Object.entries(workflow.jobs ?? {}).flatMap(([name, job]) => {
      const shell = job.defaults?.run?.shell ?? "bash";
      return shell === "bash" ? [] : [`${file} job ${name} sets shell ${shell}`];
    }),
  ]);
  for (const { at, key, run, shell = "bash" } of steps(workflows)) {
    if (shell !== "bash" && OTHER_SHELL[key] !== shell) found.push(`${at} names shell ${shell}`);
    else if (shell !== "bash" && PIPE.test(run)) found.push(`${at} holds a | under ${shell}, which has no pipefail`);
  }
  return found;
}

/**
 * Each line passing a $(...) that pipes to another command, whose exit status is then the line's, so even pipefail
 * loses the pipe's failure. A line that only assigns it, `name=$(a | b)`, fails with the pipe. Read one line at a
 * time as text: a substitution over several lines or after a line continuation, backticks and process substitution
 * are not read, and a | in quotes inside $(...) counts.
 */
const passedOn = (workflows: Workflows) =>
  steps(workflows).flatMap(({ at, run }) =>
    run
      .split("\n")
      .filter((line) => /\$\([^)]*\|/.test(line.replaceAll("||", "")) && !/^\s*(#|\w+=\$\(.*\)\s*$)/.test(line))
      .map((line) => `${at} passes on a pipe's output, which pipefail does not see fail: ${line.trim()}`),
  );

/** One bash workflow with one job running `run`. */
const one = (run: string): Workflows => ({
  "a.yml": { defaults: { run: { shell: "bash" } }, jobs: { j: { steps: [{ run }] } } },
});
// An apostrophe in a comment, then a pipe, then a quote.
const REPRO = `# The lint job's log goes to the summary.\nnpm run lint | tee "$RUNNER_TEMP/lint.log"\necho 'lint done'`;

describe("the workflows' pipes", () => {
  it("fail the step when any command in them fails", async () => {
    const workflows = await ours();
    expect(shells(workflows)).toEqual([]);
    expect(passedOn(workflows)).toEqual([]);
    expect(steps(workflows).filter(({ shell }) => shell !== undefined)).toHaveLength(Object.keys(OTHER_SHELL).length);
  });

  it("fail a workflow without bash as its default shell, a job naming another, and a step naming one not listed", async () => {
    const workflows = structuredClone(await ours());
    delete workflows["ci.yml"]!.defaults;
    workflows["corpus.yml"]!.jobs!.refresh!.defaults = { run: { shell: "bash -e {0}" } };
    workflows["golden.yml"]!.jobs!.compare!.steps![2]!.shell = "bash {0}";
    workflows["pr.yml"]!.jobs!.title!.steps![1]!.shell = SH;
    workflows["pr.yml"]!.jobs!.proof!.steps!.at(-1)!.shell = "sh";
    expect(shells(workflows)).toEqual([
      "ci.yml does not set bash as its default shell",
      "corpus.yml job refresh sets shell bash -e {0}",
      'golden.yml job compare step 3 (if [ -z "$BASE" ]; then) names shell bash {0}',
      `pr.yml job title step 2 (if git cat-file -e "$BASE:scripts/check-pr.sh" 2>/dev/null; then) names shell ${SH}`,
      "pr.yml job proof step 7 (PATH=$NODE:/usr/bin:/bin) names shell sh",
    ]);
  });

  it("fail a | anywhere in a listed /bin/sh step, in a comment or quotes too, but not ||", async () => {
    const workflows = structuredClone(await ours());
    const step = workflows["pr.yml"]!.jobs!.refactor!.steps!.at(-1)!;
    for (const run of [REPRO, "# a | b", "grep -E 'a|b' f", "a |& b"]) {
      step.run = `${run}\n/bin/sh "$dir/scripts/check-refactor.sh" --style "$BASE" "$HEAD"`;
      expect(shells(workflows), run).toEqual([
        `pr.yml job refactor step 8 (${run.split("\n")[0]}) holds a | under ${SH}, which has no pipefail`,
      ]);
    }
    step.run = 'a || b\n/bin/sh "$dir/scripts/check-refactor.sh" --style "$BASE" "$HEAD"';
    expect(shells(workflows)).toEqual([]);
  });

  it("fail a line passing a pipe's output in $(...) to another command, and not one that only assigns it", () => {
    for (const run of [
      'echo "count=$(git status --porcelain | wc -l)" >> "$GITHUB_OUTPUT"',
      'COUNT=$(git status --porcelain | wc -l) node -e "process.exit(0)"',
      "local count=$(git status --porcelain | wc -l)",
    ])
      expect(passedOn(one(run)), run).toEqual([
        `a.yml job j step 1 (${run}) passes on a pipe's output, which pipefail does not see fail: ${run}`,
      ]);
    for (const run of ["count=$(git status --porcelain | wc -l)", "a | b", "x=$(a || b) && echo", "# echo $(a | b)"])
      expect(passedOn(one(run)), run).toEqual([]);
  });

  it("do not read substitutions over several lines, backticks or process substitution, as the note above says", () => {
    for (const run of [
      'echo "$(\n  git status --porcelain | wc -l\n)"',
      'echo "$(git status --porcelain \\\n  | wc -l)"',
      "echo `git status --porcelain | wc -l`",
      'while read -r f; do echo "$f"; done < <(git ls-files | sort)',
    ])
      expect(passedOn(one(run)), run).toEqual([]);
  });
});
