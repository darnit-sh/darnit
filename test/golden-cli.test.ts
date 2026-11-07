import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { integrity } from "../scripts/e2e-env.js";

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
  const guard = steps[0]!;
  const compare = steps.find((s) => s.run?.includes("--cli"))!;
  const install = steps.find((s) => s.id === "installed")!;
  // npm and npx stand-ins that print what they were asked to run; `fails` makes npx exit 2.
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const cmd of ["npm", "npx"])
    writeFileSync(join(bin, cmd), `#!/bin/sh\nprintf '%s|' ${cmd} "$@"\n[ "$FAILS" != ${cmd} ]\n`, { mode: 0o755 });
  const sh = (step: Step, env: Record<string, string>) => {
    const [out, summary] = [join(root, "github-output"), join(root, "summary")];
    for (const f of [out, summary]) writeFileSync(f, "");
    const r = spawnSync("bash", ["-e", "-c", step.run!], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: "/rt",
        GITHUB_OUTPUT: out,
        GITHUB_STEP_SUMMARY: summary,
        ...env,
      },
    });
    const read = (f: string) => readFileSync(f, "utf8");
    return { exit: r.status, ran: r.stdout, output: read(out), summary: read(summary) };
  };

  it("passes inputs through env only, and runs npm run golden as before without one, saying so", () => {
    for (const step of steps) expect(step.run ?? "").not.toContain("${{");
    const r = sh(compare, { ALL: "yes", BASE: "b a", TARBALL: "", CLI: "" });
    expect(r.ran).toBe("npm|run|golden|--|--out|/rt/golden-update|--all|--base|b a|");
    expect(r.summary).toBe("Golden scans with dist/cli.js, built from this commit.\n");
  });

  it("scans with the installed CLI and builds nothing, saying which, and never falls back to the build", () => {
    const r = sh(compare, { TARBALL: "package", INTEGRITY: "sha512-x", CLI: "/x/darnit" });
    expect(r.ran).toBe("npx|tsx|scripts/golden.ts|--cli|/x/darnit|--out|/rt/golden-update|");
    expect(r.summary).toBe("Golden scans with the darnit installed from artifact package, integrity sha512-x.\n");
    expect(sh(compare, { TARBALL: "package", CLI: "" }).ran).toBe(
      "npx|tsx|scripts/golden.ts|--cli||--out|/rt/golden-update|",
    );
  });

  it("fails the job before anything else when only one of tarball and integrity is set", () => {
    expect(guard.run).toContain("tarball and integrity together");
    for (const [TARBALL, INTEGRITY, exit] of [
      ["package", "", 1],
      ["", "sha512-x", 1],
      ["package", "sha512-x", 0],
      ["", "", 0],
    ] as const) {
      const r = sh(guard, { TARBALL, INTEGRITY });
      expect(r.exit, `${TARBALL}/${INTEGRITY}`).toBe(exit);
      expect(r.ran.includes("::error::"), `${TARBALL}/${INTEGRITY}`).toBe(exit === 1);
    }
  });

  it("installs with the integrity from env, and fails the step without an output when the install fails", () => {
    const ok = sh(install, { INTEGRITY: "sha512-x y" });
    expect(ok.output).toBe("cli=npx|tsx|scripts/installed.ts|--tarball|/rt/package/*.tgz|--integrity|sha512-x y|\n");
    const failed = sh(install, { INTEGRITY: "sha512-x", FAILS: "npx" });
    expect(failed.exit).not.toBe(0);
    expect(failed.output).toBe("");
  });
});

describe("scripts/installed.ts", () => {
  // npm records each call, so a run that reaches the install shows up; its own temp folder holds the work folder.
  const dir = join(root, "installed");
  const npmBin = join(dir, "bin");
  mkdirSync(npmBin, { recursive: true });
  writeFileSync(join(npmBin, "npm"), `#!/bin/sh\necho "$@" >> "$NPM_LOG"\n`, { mode: 0o755 });
  const tarball = join(dir, "darnit.tgz");
  writeFileSync(tarball, "not really a tarball\n");
  const installed = (sri: string) => {
    const tmp = mkdtempSync(join(dir, "tmp-"));
    const log = join(tmp, "npm.log");
    const r = spawnSync(
      resolve("node_modules/.bin/tsx"),
      [resolve("scripts/installed.ts"), "--tarball", tarball, "--integrity", sri],
      {
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, PATH: `${npmBin}:${process.env.PATH}`, TMPDIR: tmp, NPM_LOG: log, INIT_CWD: "" },
      },
    );
    const work = readdirSync(tmp).filter((f) => f.startsWith("darnit-installed-"));
    return {
      r,
      npm: existsSync(log) ? readFileSync(log, "utf8") : "",
      work: work.flatMap((w) => readdirSync(join(tmp, w))),
    };
  };

  it("exits 1 naming both hashes when the tarball's integrity differs, and installs nothing", () => {
    const { r, npm, work } = installed("sha512-AAAA");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`has integrity ${integrity(tarball)}, expected sha512-AAAA`);
    expect(r.stdout).toBe("");
    expect(npm).toBe("");
    expect(work).toEqual(["darnit.tgz"]);
  });

  it("reaches npm with the matching integrity, so the run above would show an install", () => {
    const { npm, work } = installed(integrity(tarball));
    expect(npm.split("\n")[0]).toBe("init -y");
    expect(work).toContain("install");
  });
});
