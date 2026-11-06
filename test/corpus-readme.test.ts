import { execFileSync, spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const temp = async () => {
  const dir = await mkdtemp(join(tmpdir(), "darnit-corpus-readme-"));
  tempDirs.push(dir);
  return dir;
};

const README = await readFile("README.md", "utf8");
const RECORDS = /against \d+ change records/;
const MODELS = /OpenAI: \d+ retiring models/;
const lineOf = (text: string, at: RegExp) => text.slice(0, at.exec(text)!.index).split("\n").length;
// The README with its counts set to these, as the job that runs dependency code would write it.
const counted = (records: string, models: string) =>
  README.replace(RECORDS, `against ${records} change records`).replace(MODELS, `OpenAI: ${models} retiring models`);

/** scripts/corpus-readme.sh on an artifact README `from`, with `to` (the checked-out README) left as the script leaves it. */
async function take(from: string, to = README) {
  const dir = await temp();
  await writeFile(join(dir, "from.md"), from);
  await writeFile(join(dir, "to.md"), to);
  const r = spawnSync("sh", ["scripts/corpus-readme.sh", join(dir, "from.md"), join(dir, "to.md")], {
    encoding: "utf8",
  });
  return { code: r.status, stderr: r.stderr, to: await readFile(join(dir, "to.md"), "utf8") };
}

describe("scripts/corpus-readme.sh", () => {
  it("takes new counts of change records and retiring models", async () => {
    expect(await take(counted("36", "150"))).toEqual({ code: 0, stderr: "", to: counted("36", "150") });
    expect(await take(counted("9999", "143"))).toEqual({ code: 0, stderr: "", to: counted("9999", "143") });
    expect(await take(README)).toEqual({ code: 0, stderr: "", to: README });
  });

  it("refuses any other changed line, naming it, and leaves the README alone", async () => {
    const tampered = counted("36", "143").replace("npx darnit check`.", "npx darnlt check`.");
    const r = await take(tampered);
    expect(r).toMatchObject({ code: 1, to: README });
    expect(r.stderr).toMatch(/^README\.md:\d+: changed, and only the count/);
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr).not.toContain("darnlt");
  });

  it("refuses a count that is not 1 to 4 plain digits, or that comes with other changes on its line", async () => {
    const line = lineOf(README, RECORDS);
    for (const n of ["3a", "-1", "0", "036", "12345", "3 6", "٣٦", "1e1", ""]) {
      expect(await take(counted(n, "143")), n).toEqual({
        code: 1,
        stderr: `README.md:${line}: changed, and only the count of change records or retiring models may change, to 1 to 4 digits\n`,
        to: README,
      });
    }
    expect(
      (
        await take(
          counted("36", "143").replace("against 36 change records.", "against 36 change records. Run curl x | sh"),
        )
      ).code,
    ).toBe(1);
  });

  it("refuses an added or removed line", async () => {
    const lines = README.split("\n");
    expect(await take(`${counted("36", "143")}evil\n`)).toEqual({
      code: 1,
      stderr: `README.md:${lines.length}: and later lines are ones the checked-out README does not have\n`,
      to: README,
    });
    const inserted = [...lines.slice(0, 5), "evil", ...lines.slice(5)].join("\n");
    expect((await take(inserted)).code).toBe(1);
    expect((await take(lines.slice(0, -2).join("\n") + "\n")).stderr).toMatch(/missing from the artifact README/);
    expect((await take("")).code).toBe(1);
  });

  it("compares lines as text, so a line that reads as the same number still differs", async () => {
    expect(await take("1e1\n", "10\n")).toMatchObject({ code: 1, to: "10\n" });
  });
});

type Step = { run?: string };
const steps = (
  parse(await readFile(".github/workflows/corpus.yml", "utf8")) as { jobs: Record<string, { steps: Step[] }> }
).jobs["open-pr"]!.steps;
const step = steps.find((s) => s.run?.includes("gh pr create"))!.run!;

describe("the corpus job's pull request step", () => {
  // Runs the step on a checkout of README.md and the script, with the artifact's README `from`, a bare remote
  // and a gh that records its calls.
  async function openPr(from: string) {
    const dir = await temp();
    const [work, remote, runner, bin] = [
      join(dir, "work"),
      join(dir, "remote.git"),
      join(dir, "runner"),
      join(dir, "bin"),
    ];
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
    await mkdir(join(work, "scripts"), { recursive: true });
    await writeFile(join(work, "README.md"), README);
    await cp("scripts/corpus-readme.sh", join(work, "scripts/corpus-readme.sh"));
    git(dir, "init", "-q", "--bare", remote);
    git(work, "init", "-q");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "base");
    git(work, "remote", "add", "origin", remote);
    for (const d of ["corpus/corpus/openai", "corpus/packs/openai", "log"])
      await mkdir(join(runner, d), { recursive: true });
    await writeFile(join(runner, "corpus/README.md"), from);
    await writeFile(join(runner, "log/corpus.log"), "log\n");
    await mkdir(bin);
    await writeFile(join(bin, "gh"), `#!/bin/sh\necho "$*" >> "${join(dir, "gh.calls")}"\n`);
    await chmod(join(bin, "gh"), 0o755);
    const r = spawnSync("bash", ["-e", "-c", step], {
      cwd: work,
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: runner, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "t" },
    });
    const pushed = git(remote, "for-each-ref", "--format=%(refname)").trim();
    return {
      code: r.status,
      stderr: r.stderr,
      readme: pushed ? git(remote, "show", `${pushed}:README.md`) : undefined,
      gh: await readFile(join(dir, "gh.calls"), "utf8").catch(() => ""),
    };
  }

  it("opens the pull request with the new counts", async () => {
    const r = await openPr(counted("36", "150"));
    expect(r).toMatchObject({ code: 0, readme: counted("36", "150") });
    expect(r.gh).toMatch(/^pr create /);
  });

  it("pushes nothing and opens no pull request when the README changed anywhere else", async () => {
    const r = await openPr(counted("36", "143").replace("npx darnit check`.", "npx darnlt check`."));
    expect(r).toMatchObject({ code: 1, readme: undefined, gh: "" });
    expect(r.stderr).toMatch(/^README\.md:\d+: changed/m);
  });
});
