import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checking, ci, loosened } from "./ci-steps.js";
import { read } from "./docs.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FORMAT = "npm run format:check";
const scripts = async () => (JSON.parse(await read("package.json")) as { scripts: Record<string, string> }).scripts;
const git = (...args: string[]) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });

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

/** The exit code of prettier run with `args` over a folder holding only a badly formatted `file`, which .gitignore lists. */
async function checkAlone(args: string[], file: string): Promise<number | null> {
  const dir = await mkdtemp(join(tmpdir(), "darnit-format-"));
  try {
    for (const f of [".prettierignore", ".prettierrc.json"]) await copyFile(join(ROOT, f), join(dir, f));
    await writeFile(join(dir, ".gitignore"), "src/\n");
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, file), "export   const badly={a:1}\n");
    const prettier = join(ROOT, "node_modules/prettier/bin/prettier.cjs");
    const child = spawn(process.execPath, [prettier, ...args], { cwd: dir, stdio: "ignore" });
    return await new Promise((done, fail) => child.on("error", fail).on("close", done));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// CI's test job fetches two commits; history older than that is only there in a full clone.
const shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: ROOT }).toString().trim();

describe("the format check", () => {
  it("runs in the lint job, and fails when the step moves or goes", async () => {
    expect(checking(await ci(), FORMAT)).toEqual(["lint"]);
    const moved = await ci();
    const lint = moved.jobs!.lint!;
    const step = lint.steps!.findIndex((s) => s.run === FORMAT);
    moved.jobs!.test!.steps!.push(...lint.steps!.splice(step, 1));
    expect(checking(moved, FORMAT)).toEqual(["test"]);
    moved.jobs!.test!.steps!.pop();
    expect(checking(moved, FORMAT)).toEqual([]);
  });

  it("fails when the step or the lint job may be skipped or may fail without failing the run", async () => {
    for await (const { workflow, how } of loosened("lint", FORMAT)) expect(checking(workflow, FORMAT), how).toEqual([]);
  });

  it("reads only .prettierignore, so .gitignore cannot drop a file, and checks every code extension", async () => {
    const { format, "format:check": check } = await scripts();
    expect(format).toBe(check!.replace("--check", "--write"));
    const [bin, ...args] = check!.split(" ");
    expect(bin).toBe("prettier");
    const code = ["ts", "js", "mjs", "cjs", "mts", "cts", "tsx", "jsx"].map((e) => `src/bad.${e}`);
    const status = await Promise.all([...code, "src/notes.md"].map(async (f) => [f, await checkAlone(args, f)]));
    // 1 is prettier's exit code for unformatted files; only the exit code is read, as CI colors the output.
    expect(Object.fromEntries(status)).toEqual({ ...Object.fromEntries(code.map((f) => [f, 1])), "src/notes.md": 0 });
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
