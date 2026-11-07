import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Workflow = { jobs?: Record<string, { steps?: { run?: string }[] }> };

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFile(new URL(path, ROOT), "utf8");
const ci = async () => parse(await read(".github/workflows/ci.yml")) as Workflow;
const git = (...args: string[]) => spawnSync("git", args, { cwd: fileURLToPath(ROOT), encoding: "utf8" });

/** The jobs that run the format check. */
const checking = (workflow: Workflow) =>
  Object.entries(workflow.jobs ?? {})
    .filter(([, job]) => (job.steps ?? []).some((s) => s.run?.trim() === "npm run format:check"))
    .map(([name]) => name);

/** Each line of an ignore-revs file that is not one full commit id, and a missing final newline. */
function badLines(text: string): string[] {
  const lines = text.split("\n");
  const bad = lines.slice(0, -1).filter((l, i) => !/^[0-9a-f]{40}$/.test(l) || lines.indexOf(l) !== i);
  return lines.at(-1) === "" ? bad : [...bad, `${lines.at(-1)} (no final newline)`];
}

/** Each id that is not a commit in HEAD's history. */
const notInHistory = (ids: string[]) =>
  ids.filter(
    (id) =>
      git("cat-file", "-t", id).stdout.trim() !== "commit" || git("merge-base", "--is-ancestor", id, "HEAD").status,
  );

// CI's test job fetches two commits; history older than that is only there in a full clone.
const shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: fileURLToPath(ROOT) })
  .toString()
  .trim();

describe("the format check", () => {
  it("runs in the lint job, and fails when the step moves or goes", async () => {
    expect(checking(await ci())).toEqual(["lint"]);
    const pkg = JSON.parse(await read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["format:check"]).toBe("prettier --check .");
    const moved = structuredClone(await ci());
    const lint = moved.jobs!.lint!;
    const step = lint.steps!.findIndex((s) => s.run === "npm run format:check");
    moved.jobs!.test!.steps!.push(...lint.steps!.splice(step, 1));
    expect(checking(moved)).toEqual(["test"]);
    moved.jobs!.test!.steps!.pop();
    expect(checking(moved)).toEqual([]);
  });
});

describe("the blame ignore list", () => {
  it("holds one full commit id per line", async () => {
    expect(badLines(await read(".git-blame-ignore-revs"))).toEqual([]);
    const id = "663278132a6c5be5b8b980cb0c9f5c4734bf387b";
    expect(badLines(`${id}\n${id.slice(0, 12)}\n${id.toUpperCase()}\n${id} \n\n# x\n${id}\n${id}`)).toEqual([
      id.slice(0, 12),
      id.toUpperCase(),
      `${id} `,
      "",
      "# x",
      id,
      `${id} (no final newline)`,
    ]);
  });

  it.skipIf(shallow === "true")("names only commits in this history, in a full clone", async () => {
    const ids = (await read(".git-blame-ignore-revs")).split("\n").filter(Boolean);
    expect(ids).toHaveLength(3);
    expect(notInHistory(ids)).toEqual([]);
    const tree = git("rev-parse", "HEAD^{tree}").stdout.trim();
    expect(notInHistory(["0".repeat(40), tree])).toEqual(["0".repeat(40), tree]);
  });
});
