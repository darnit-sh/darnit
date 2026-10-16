import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { drops, lines, shrunk } from "../scripts/golden.js";

const report = (file: string) => ({
  scanned: { files: 1, records: 2 },
  hits: [{ id: "r", file, line: 3, column: 4, text: "max_tokens: 5" }],
  possiblyAffected: [],
  mentions: [{ id: "r", file, line: 3, model: "gpt-4" }],
});

describe("golden result lines", () => {
  it("keeps one finding per line when a path holds a line break", () => {
    const out = lines(1, report("a\nM fake.py:1 gpt-4 x\u2028y\u0085.js"));
    expect(out.split("\n")).toHaveLength(5);
    expect(out).toContain('M "a\\nM fake.py:1 gpt-4 x\\u2028y\\u0085.js":3 gpt-4 r');
  });

  it("writes plain paths as they are, with a short hash of the matched code", () => {
    expect(lines(1, report("src/app.ts"))).toBe(
      ["exit 1", "scanned files=1 records=2 otherFiles=0 foreign=0 tooLarge=0 skipped=0", "H src/app.ts:3:4 #a4d75be4 r", "M src/app.ts:3 gpt-4 r", ""].join("\n"),
    );
  });
});

describe("golden drop lines", () => {
  it("lets only the named repo leave, with a reason of at least 10 characters, outside comments and code", () => {
    const body = [
      "Golden drop: a/one, repository was deleted upstream",
      "Golden drop: a/two, too short",
      "<!-- Golden drop: a/three, hidden in a comment here -->",
      "```",
      "Golden drop: a/four, inside a fenced code block",
      "```",
      "  Golden drop: a/five, indented so not a plain line",
    ].join("\r\n");
    expect([...drops(body)]).toEqual([["a/one", "repository was deleted upstream"]]);
    expect(drops("<!-- open comment\nGolden drop: a/six, never closed so still hidden").size).toBe(0);
  });
});

describe("golden repos a branch stops comparing", () => {
  it("names repos gone from repos.tsv or out of the slice, not repos that joined it", () => {
    const row = (repo: string, slice: boolean) => ({ repo, sha: "0".repeat(40), slice, file: `${repo}.txt` });
    const base = [row("a/kept", true), row("a/demoted", true), row("a/gone", false), row("a/promoted", false)];
    const head = [row("a/kept", true), row("a/demoted", false), row("a/promoted", true), row("a/new", false)];
    expect(shrunk(base, head).map((r) => r.repo)).toEqual(["a/demoted", "a/gone"]);
  });
});

describe("golden workflow scope", () => {
  const workflow = parse(readFileSync(".github/workflows/golden.yml", "utf8")) as { jobs: { compare: { steps: { id?: string; run?: string }[] } } };
  const run = workflow.jobs.compare.steps.find((s) => s.id === "scope")?.run ?? "";

  /** The set the scope step picks for a pull request that adds `files`, and its summary line. Actions runs a step with no `shell:` as `bash -e`. */
  function scope(files: string[], shell = ["-e"]): [string, string] {
    const tmp = mkdtempSync(join(tmpdir(), "darnit-golden-scope-"));
    const dir = join(tmp, "repo");
    mkdirSync(dir);
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" }).trim();
    try {
      git("init", "-q");
      git("commit", "-q", "--allow-empty", "-m", "base");
      const base = git("rev-parse", "HEAD");
      for (const f of files) {
        mkdirSync(dirname(join(dir, f)), { recursive: true });
        writeFileSync(join(dir, f), "x\n");
      }
      git("add", ".");
      git("commit", "-q", "-m", "head");
      const env = { ...process.env, BASE: base, HEAD: git("rev-parse", "HEAD"), EVENT: "pull_request", GITHUB_OUTPUT: join(tmp, "out"), GITHUB_STEP_SUMMARY: join(tmp, "summary") };
      execFileSync("bash", [...shell, "-c", run], { cwd: dir, env, stdio: "ignore" });
      return [readFileSync(env.GITHUB_OUTPUT, "utf8").trim(), readFileSync(env.GITHUB_STEP_SUMMARY, "utf8").trim()];
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  it("skips only Markdown and LICENSE changes", () => {
    expect(scope(["README.md", "docs/a.md", "LICENSE"])[0]).toBe("set=skip");
  });

  it("compares the slice when nothing that can change scan results changed", () => {
    expect(scope(["README.md", ".github/workflows/ci.yml", "test/check.test.ts"])[0]).toBe("set=slice");
  });

  it("compares all repos when detection code, the stored results or the parser version changes, and says which file", () => {
    const files = ["src/scan/detect.ts", "packs/openai/x/rules/é.yml", "test/golden/a_b.txt", "scripts/golden.ts", ".github/workflows/golden.yml", "package-lock.json", "tsconfig.build.json"];
    for (const f of files) expect(scope(["README.md", f])).toEqual(["set=all", `Golden compares all pinned repositories: this pull request changes ${f}, which can change scan results.`]);
    expect(scope(["README.md", 'src/a"b.ts'])[0]).toBe("set=all");
    expect(scope(['docs/a"b.md'])[0]).toBe("set=slice");
  });

  it("never skips a long change list that holds code before its Markdown, also with pipefail on", () => {
    const files = [".github/workflows/ci.yml", ...Array.from({ length: 3000 }, (_, i) => `docs/${String(i).padStart(40, "0")}.md`)];
    expect(scope(files)[0]).toBe("set=slice");
    expect(scope(files, ["-eo", "pipefail"])[0]).toBe("set=slice");
  });
});
