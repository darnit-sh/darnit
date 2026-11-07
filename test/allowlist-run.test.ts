import { appendFile, mkdir, readFile, rename as move, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copy, npm, run } from "./allowlist-copy.js";
import { checking, ci, loosened } from "./ci-steps.js";

describe("what the check reads", () => {
  it("reads a list only as a file at its own path, never through a link", async () => {
    const dir = await copy();
    await move(join(dir, "scripts/allow"), join(dir, "scripts/lists"));
    await symlink("lists", join(dir, "scripts/allow"));
    expect(run("unused", dir).out).toContain("scripts/allow/unused.tsv is reached through a link or is not a file");
    await rm(join(dir, "scripts/allow"));
    await mkdir(join(dir, "scripts/allow"));
    await symlink("../lists/duplicates.tsv", join(dir, "scripts/allow/duplicates.tsv"));
    const r = run("duplicates", dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain("scripts/allow/duplicates.tsv is reached through a link or is not a file");
    await rm(join(dir, "scripts/allow/duplicates.tsv"));
    await move(join(dir, "scripts/lists/duplicates.tsv"), join(dir, "scripts/allow/duplicates.tsv"));
    await move(join(dir, "scripts"), join(dir, "tools"));
    await symlink("tools", join(dir, "scripts"));
    expect(run("duplicates", dir).out).toContain(
      "scripts/allow/duplicates.tsv is reached through a link or is not a file",
    );
  });

  it("refuses to run with a knip or jscpd key in package.json, which knip reads whatever --config says", async () => {
    const dir = await copy();
    await writeFile(join(dir, "src/orphan.ts"), "export const orphan = 1;\n");
    const pkg = join(dir, "package.json");
    await writeFile(
      pkg,
      JSON.stringify({
        ...JSON.parse(await readFile(pkg, "utf8")),
        knip: { ignore: ["src/orphan.ts"] },
        jscpd: { ignore: ["**/versions.ts"] },
      }),
    );
    const unused = run("unused", dir);
    expect(unused.status).toBe(1);
    expect(unused.out).toContain(
      'package.json has a "knip" key, which would add to what knip.json and this check set; remove it',
    );
    expect(run("duplicates", dir).out).toContain('package.json has a "jscpd" key');
  });

  it("fails when either tool exits with an error, and on a line with no reason", async () => {
    const dir = await copy();
    await rm(join(dir, "node_modules"));
    await mkdir(join(dir, "node_modules/.bin"), { recursive: true });
    for (const name of ["knip", "jscpd"])
      await writeFile(join(dir, "node_modules/.bin", name), "#!/bin/sh\necho broken >&2\nexit 3\n", { mode: 0o755 });
    for (const [kind, name] of [
      ["unused", "knip"],
      ["duplicates", "jscpd"],
    ] as const) {
      const r = run(kind, dir);
      expect(r.status, name).toBe(1);
      expect(r.out).toContain(`${name} exited 3; run npx ${name} to see why\nbroken`);
    }
    const plain = await copy();
    await appendFile(join(plain, "scripts/allow/duplicates.tsv"), "src/a.ts\tsrc/b.ts\t#1\n");
    const r = run("duplicates", plain);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/scripts\/allow\/duplicates\.tsv: line \d+ needs 3 fields and a reason, tab separated/);
  });
});

describe("the checks as the lint job runs them", () => {
  it("pass on a copy of this repository, and say so", async () => {
    const dir = await copy();
    expect(npm(dir, "knip")).toMatchObject({
      status: 0,
      out: "unused: every finding is in scripts/allow/unused.tsv\n",
    });
    expect(npm(dir, "limits")).toMatchObject({
      status: 0,
      out: "limits: every finding is in scripts/allow/limits.tsv\n",
    });
  });

  it("fail when scripts/ is a link, whatever the copy behind it holds", async () => {
    const dir = await copy();
    await mkdir(join(dir, "tools"));
    await move(join(dir, "scripts"), join(dir, "tools/scripts"));
    await symlink("tools/scripts", join(dir, "scripts"));
    for (const [script, file] of [
      ["knip", "unused"],
      ["duplicates", "duplicates"],
      ["limits", "limits"],
    ]) {
      const r = npm(dir, script!);
      expect(r.status, script).toBe(1);
      expect(r.out).toContain(`scripts/allow/${file}.tsv is reached through a link or is not a file`);
    }
  });

  it("fail when scripts/allow is missing", async () => {
    const dir = await copy();
    await rm(join(dir, "scripts/allow"), { recursive: true });
    for (const [script, file] of [
      ["knip", "unused"],
      ["duplicates", "duplicates"],
      ["limits", "limits"],
    ]) {
      const r = npm(dir, script!);
      expect(r.status, script).toBe(1);
      expect(r.out).toContain(`scripts/allow/${file}.tsv is missing`);
    }
  });

  it("run in the lint job every time, and fail the run when they fail", async () => {
    for (const script of ["knip", "duplicates", "limits"]) {
      const step = `npm run ${script}`;
      expect(checking(await ci(), step), script).toEqual(["lint"]);
      for await (const { workflow, how } of loosened("lint", step))
        expect(checking(workflow, step), `${script}: ${how}`).toEqual([]);
    }
  });
});
