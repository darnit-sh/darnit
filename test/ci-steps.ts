import { parse } from "yaml";
import { read } from "./docs.js";

// Which jobs of ci.yml run a step every time and fail when it fails, for the tests that hold a check to CI.

type Gated = { if?: unknown; "continue-on-error"?: unknown };
export type Workflow = { jobs?: Record<string, Gated & { steps?: (Gated & { run?: string })[] }> };

export const ci = async () => parse(await read(".github/workflows/ci.yml")) as Workflow;

const always = (at: Gated) => at.if === undefined && at["continue-on-error"] === undefined;
/** The jobs that always run `run` and fail when it fails. */
export const checking = (workflow: Workflow, run: string) =>
  Object.entries(workflow.jobs ?? {})
    .filter(([, job]) => always(job) && (job.steps ?? []).some((s) => always(s) && s.run === run))
    .map(([name]) => name);

/** A copy of ci.yml for each way the step running `run`, or its job, may be skipped or fail without failing the run. */
export async function* loosened(job: string, run: string) {
  for (const [key, value] of [
    ["if", false],
    ["if", "github.event_name == 'push'"],
    ["continue-on-error", true],
  ] as const)
    for (const on of ["step", "job"]) {
      const workflow = await ci();
      const at = on === "job" ? workflow.jobs![job]! : workflow.jobs![job]!.steps!.find((s) => s.run === run)!;
      at[key] = value;
      yield { workflow, how: `${key} on the ${on}` };
    }
}
