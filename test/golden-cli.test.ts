import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

// A project folder holding one pinned repo, already cloned at its SHA so nothing is fetched, and stand-ins for
// the CLI: each answers --version and reports a different file, so the stored result shows which one scanned.
const root = mkdtempSync(join(tmpdir(), "darnit-golden-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const clones = join(root, "clones");
const repo = join(clones, "t_repo");
mkdirSync(repo, { recursive: true });
const git = (...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, encoding: "utf8" }).trim();
git("init", "-q");
writeFileSync(join(repo, "a.js"), "x\n");
git("add", ".");
git("commit", "-q", "-m", "pin");
mkdirSync(join(root, "test", "golden"), { recursive: true });
writeFileSync(
  join(root, "test", "golden", "repos.tsv"),
  `repo\tsha\tslice\tshape\nt/repo\t${git("rev-parse", "HEAD")}\tyes\tx\n`,
);
writeFileSync(
  join(root, "test", "golden", "t_repo.txt"),
  "exit 1\nscanned files=1 records=1 otherFiles=0 foreign=0 tooLarge=0 skipped=0\nM from-installed.js:1 gpt-4 r\n",
);

const fake = (name: string, file: string, body?: string) => {
  const report = {
    scanned: { files: 1, records: 1 },
    hits: [],
    possiblyAffected: [],
    mentions: [{ id: "r", file, line: 1, model: "gpt-4" }],
  };
  const path = join(root, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    body ??
      `if (process.argv[2] === "--version") console.log("9.9.9-fake");\nelse { console.log(${JSON.stringify(JSON.stringify(report))}); process.exitCode = 1; }\n`,
  );
  return path;
};
const installed = fake("installed/cli.js", "from-installed.js");
const built = fake("dist/cli.js", "from-dist.js");

const golden = (...args: string[]) => {
  const env: NodeJS.ProcessEnv = { ...process.env, INIT_CWD: root };
  for (const k of ["GITHUB_ACTIONS", "GITHUB_STEP_SUMMARY", "PR_BODY"]) delete env[k];
  const r = spawnSync(resolve("node_modules/.bin/tsx"), [resolve("scripts/golden.ts"), "--dir", clones, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { exit: r.status, out: `${r.stdout}${r.stderr}`, stderr: r.stderr };
};

describe("golden --cli", () => {
  it("scans with the named CLI, and fails naming the repo when its result differs", () => {
    const ok = golden("--cli", installed);
    expect(ok.out).toContain(`scanning with darnit 9.9.9-fake from ${installed}`);
    expect(ok.out).toContain("Compared 1 of 1 pinned repositories");
    expect(ok.exit).toBe(0);
    const wrong = golden("--cli", built);
    expect(wrong.out).toContain("t/repo result differs from test/golden/t_repo.txt");
    expect(wrong.out).toContain("+M from-dist.js:1 gpt-4 r");
    expect(wrong.exit).toBe(1);
  });

  it("scans with dist/cli.js without the flag, as before", () => {
    const r = golden();
    expect(r.out).toContain("t/repo result differs from test/golden/t_repo.txt");
    expect(r.out).toContain("+M from-dist.js:1 gpt-4 r");
    expect(r.out).not.toContain("scanning with");
    expect(r.exit).toBe(1);
    expect(built).toBe(join(root, "dist", "cli.js"));
  });

  it("exits 2 with a plain message, scanning nothing, for no value, a missing file, a folder or a CLI that does not run", () => {
    const cases: [string[], string][] = [
      [["--cli"], "argument missing"],
      [["--cli", "--all"], "argument is ambiguous"],
      [["--cli", ""], "is not a file"],
      [["--cli", join(root, "missing.js")], "is not a file"],
      [["--cli", clones], "is not a file"],
      [["--cli", fake("broken.js", "", "this is not javascript {\n")], "does not run"],
      [["--cli", fake("silent.js", "", "")], "does not run"],
      [["--cli", fake("fails.js", "", "process.exit(3);\n")], "does not run"],
    ];
    for (const [args, says] of cases) {
      const r = golden(...args);
      expect(r.exit, args.join(" ")).toBe(2);
      expect(r.stderr, args.join(" ")).toContain(says);
      expect(r.stderr, args.join(" ")).not.toMatch(/^\s+at /m);
      expect(r.out, args.join(" ")).not.toContain("Compared");
    }
  });
});

describe("golden workflow with a tarball input", () => {
  type Step = { id?: string; if?: string; run?: string; env?: Record<string, string> };
  const steps = (
    parse(readFileSync(".github/workflows/golden.yml", "utf8")) as { jobs: { compare: { steps: Step[] } } }
  ).jobs.compare.steps;
  const compare = steps.find((s) => s.run?.includes("--cli"))!;
  const install = steps.find((s) => s.id === "installed")!;
  // npm and npx stand-ins that print what they were asked to run; `fails` makes npx exit 2.
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const cmd of ["npm", "npx"])
    writeFileSync(join(bin, cmd), `#!/bin/sh\nprintf '%s|' ${cmd} "$@"\n[ "$FAILS" != ${cmd} ]\n`, { mode: 0o755 });
  const sh = (step: Step, env: Record<string, string>) => {
    const out = join(root, "github-output");
    writeFileSync(out, "");
    const r = spawnSync("bash", ["-e", "-c", step.run!], {
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: "/rt", GITHUB_OUTPUT: out, ...env },
    });
    return { exit: r.status, ran: r.stdout, output: readFileSync(out, "utf8") };
  };

  it("passes inputs through env only, and runs npm run golden as before without one", () => {
    for (const step of steps) expect(step.run ?? "").not.toContain("${{");
    expect(sh(compare, { ALL: "yes", BASE: "b a", TARBALL: "", CLI: "" }).ran).toBe(
      "npm|run|golden|--|--out|/rt/golden-update|--all|--base|b a|",
    );
  });

  it("scans with the installed CLI and builds nothing, and never falls back to the build", () => {
    expect(sh(compare, { TARBALL: "package", CLI: "/x/darnit" }).ran).toBe(
      "npx|tsx|scripts/golden.ts|--cli|/x/darnit|--out|/rt/golden-update|",
    );
    expect(sh(compare, { TARBALL: "package", CLI: "" }).ran).toBe(
      "npx|tsx|scripts/golden.ts|--cli||--out|/rt/golden-update|",
    );
  });

  it("installs with the integrity from env, and fails the step without an output when the install fails", () => {
    const ok = sh(install, { INTEGRITY: "sha512-x y" });
    expect(ok.output).toBe("cli=npx|tsx|scripts/installed.ts|--tarball|/rt/package/*.tgz|--integrity|sha512-x y|\n");
    const failed = sh(install, { INTEGRITY: "sha512-x", FAILS: "npx" });
    expect(failed.exit).not.toBe(0);
    expect(failed.output).toBe("");
  });
});
