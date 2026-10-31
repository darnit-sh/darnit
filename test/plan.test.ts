import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git, patch as gitPatch } from "../src/git.js";
import { CAPS, parsePlan, serializePlan, type Plan } from "../src/plan.js";
import { loadRecords } from "../src/records/load.js";
import { cpuTime } from "./helpers.js";

const ids = new Set((await loadRecords()).map((l) => l.record.id));
const ID = [...ids][0]!;
const SHA = "a".repeat(40);
const PATCH = `diff --git a/app.py b/app.py\nindex ${"1".repeat(40)}..${"2".repeat(40)} 100644\n--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n-max_tokens=5\n+max_completion_tokens=5\n`;
const outcome = { command: "npm test", passed: true, attributed: null, notChecked: false, timedOut: false, output: "ok" };

const valid = (): Plan => ({ version: 1, darnit: "0.2.0", base: SHA, groups: [{ id: ID, files: ["app.py"], patch: PATCH, build: null, buildNote: null, tests: { ...outcome }, testsNote: null }] });
const text = (plan: unknown) => JSON.stringify(plan);
const group = (change: Record<string, unknown>) => ({ ...valid(), groups: [{ ...valid().groups[0], ...change }] });

describe("parsePlan", () => {
  it("accepts the plan darnit writes, and writes the same bytes whatever order its keys were set in", () => {
    const plan = valid();
    expect(parsePlan(serializePlan(plan, ids), ids)).toEqual(plan);
    const reordered = { groups: [{ testsNote: null, tests: { ...outcome }, buildNote: null, build: null, patch: PATCH, files: ["app.py"], id: ID }], base: SHA, darnit: "0.2.0", version: 1 } as const;
    expect(serializePlan(reordered as unknown as Plan, ids)).toBe(serializePlan(plan, ids));
  });

  it.each([
    ["the plan", { ...valid(), extra: 1 }],
    ["a group", group({ token: "x" })],
    ["a check", group({ tests: { ...outcome, env: "x" } })],
  ])("rejects an unknown field in %s", (_, plan) => {
    expect(() => parsePlan(text(plan), ids)).toThrow(/unknown field/);
  });

  it.each([
    ["the patch", group({ patch: PATCH + "+".repeat(CAPS.patch) })],
    ["the test output", group({ tests: { ...outcome, output: "x".repeat(CAPS.output + 1) } })],
    ["the command", group({ tests: { ...outcome, command: "x".repeat(CAPS.command + 1) } })],
    ["a note", group({ tests: null, testsNote: "x".repeat(CAPS.note + 1) })],
    ["the darnit version", { ...valid(), darnit: "x".repeat(CAPS.darnit + 1) }],
    ["the list of files", group({ files: Array.from({ length: CAPS.files + 1 }, (_, i) => `f${i}.py`) })],
    ["the list of changes", { ...valid(), groups: Array.from({ length: CAPS.groups + 1 }, () => valid().groups[0]) }],
  ])("rejects %s over its cap", (_, plan) => {
    expect(() => parsePlan(text(plan), ids)).toThrow(/over the cap/);
  });

  it("rejects a whole plan over its cap before reading it", () => {
    expect(() => parsePlan(" ".repeat(CAPS.plan + 1), ids)).toThrow(`plan is over the cap of ${CAPS.plan} bytes`);
  });

  it("rejects a note on a check that ran, and a check that did not run with no note", () => {
    const why = /a note says why a check did not run/;
    expect(() => parsePlan(text(group({ testsNote: "skipped with --no-test" })), ids)).toThrow(why);
    expect(() => parsePlan(text(group({ tests: null })), ids)).toThrow(why);
    expect(() => parsePlan(text(group({ build: { ...outcome }, buildNote: "skipped with --no-test" })), ids)).toThrow(why);
    expect(parsePlan(text(group({ tests: null, testsNote: "no test command found in this repository", buildNote: "package.json could not be read" })), ids).groups[0]).toMatchObject({ build: null, tests: null });
  });

  it("rejects a change record darnit does not have, or one named twice", () => {
    expect(() => parsePlan(text(group({ id: "openai:2024-01-01:made-up" })), ids)).toThrow(/does not have: "openai:2024-01-01:made-up"/);
    expect(() => parsePlan(text({ ...valid(), groups: [valid().groups[0], valid().groups[0]] }), ids)).toThrow(/twice/);
  });

  it.each([
    ["empty", ""],
    ["not a diff", "rm -rf /\n"],
    ["for another file", PATCH.replaceAll("app.py", "other.py")],
    ["with no index line", PATCH.replace(/^index .*\n/m, "")],
    ["with a short index", PATCH.replace(/1{40}\.\.2{40}/, "1111111..2222222")],
    ["that adds a file", PATCH.replace(/^index /m, "new file mode 100644\nindex ")],
    ["with a second file not listed", PATCH + PATCH.replaceAll("app.py", "b.py")],
    ["with no final newline", PATCH.trimEnd()],
    ["holding a NUL", PATCH.replace("+max", "+\0max")],
    ["with a stray line after its hunk", PATCH + "rename to ../../etc/x\n"],
    ["with a mode line", PATCH.replace(/^index /m, "old mode 100644\nnew mode 100755\nindex ")],
    ["with a hunk short of the lines it counts", PATCH.replace("+max_completion_tokens=5\n", "")],
    ["with a hunk longer than it counts", PATCH + "+extra\n"],
    ["with a blank line in a hunk", PATCH.replace("@@ -1 +1 @@\n", "@@ -1,2 +1,2 @@\n\n")],
    ["with no hunk", PATCH.replace(/@@[^]*$/, "")],
    ["with the same file twice", PATCH + PATCH],
    ["with a space name missing git's tab", PATCH.replaceAll("app.py", "a p.py")],
    ["with a binary patch missing its blank line", PATCH.replace(/--- [^]*$/, "GIT binary patch\nliteral 3\nCcmZ\nliteral 3\nCcmZ\n\n")],
    ["with a binary patch holding a stray line", PATCH.replace(/--- [^]*$/, "GIT binary patch\nliteral 3\nCcmZ\nrename to x\nliteral 3\nCcmZ\n\n")],
    ["with more context lines than its hunk counts before", PATCH.replace(/@@ -1 \+1 @@\n[^]*$/, "@@ -1,1 +1,2 @@\n a\n b\n")],
    ["with a binary patch holding a line that is not base85", PATCH.replace(/--- [^]*$/, "GIT binary patch\nliteral 3\nCcmZ\nrm -rf /\n\nliteral 3\nCcmZ\n\n")],
    ["for a symbolic link", PATCH.replace(" 100644\n", " 120000\n")],
    ["with a binary patch missing its size", PATCH.replace(/--- [^]*$/, "GIT binary patch\nCcmZ\n\nliteral 3\nCcmZ\n\n")],
  ])("rejects a patch %s", (_, patch) => {
    expect(() => parsePlan(text(group({ patch })), ids)).toThrow(/patch is not a git diff of exactly these files/);
  });

  it("rejects a file listed that the patch does not change", () => {
    expect(() => parsePlan(text(group({ files: ["app.py", "b.py"] })), ids)).toThrow(/patch is not a git diff/);
  });

  it.each(["../app.py", "/etc/passwd", "a/../../app.py", ".git/config", "sub/.GIT/hooks/pre-commit", "a//b", "./app.py", ".git ", ".git.", "sub/.GIT. ./x", "git~1/config", "GIT~1", ".g\u200cit/hooks", "a/.git\ufeff/x", ".git::$INDEX_ALLOCATION/config", ".git:x/config", "sub/GIT~1:x/y", "a\0b", ""])(
    "rejects the path %j as not inside the repository",
    (file) => {
      expect(() => parsePlan(text(group({ files: [file], patch: PATCH.replaceAll("app.py", file) })), ids)).toThrow(/not a path inside the repository/);
    },
  );

  it("rejects another format version, a base that is not a commit id, and text that is not JSON", () => {
    expect(() => parsePlan(text({ ...valid(), version: 2 }), ids)).toThrow(/invalid plan/);
    expect(() => parsePlan(text({ ...valid(), base: "HEAD" }), ids)).toThrow(/not a commit id/);
    expect(() => parsePlan("{", ids)).toThrow("plan is not JSON");
  });

  it("stays fast on the largest plan it accepts", async () => {
    const files = Array.from({ length: CAPS.files }, (_, i) => `src/${"d".repeat(150)}/f${i}.js`);
    const one = (f: string) => PATCH.replaceAll("app.py", f).replace("-max_tokens=5\n", `-${"x".repeat(200)}\n`);
    const patch = files.map(one).join("");
    const groups = [...ids].map((id) => ({ ...valid().groups[0]!, id, files, patch }));
    let plan = text({ ...valid(), groups });
    while (Buffer.byteLength(plan) > CAPS.plan) plan = text({ ...valid(), groups: (groups.pop(), groups) });
    expect(Buffer.byteLength(plan)).toBeGreaterThan(CAPS.plan / 2);
    expect(await cpuTime(() => parsePlan(plan, ids), 3, 200)).toBeLessThan(200);
  });

  it("stays fast on paths of thousands of parts", async () => {
    const deep = Array(2048).fill("a").join("/");
    const plan = text({ ...valid(), groups: [...ids].slice(0, 2).map((id) => ({ ...valid().groups[0]!, id, files: Array(CAPS.files).fill(deep) })) });
    expect(Buffer.byteLength(plan)).toBeGreaterThan(CAPS.plan * 0.95);
    const reject = () => expect(() => parsePlan(plan, ids)).toThrow(/patch is not a git diff/);
    expect(await cpuTime(reject, 3, 200)).toBeLessThan(200);
  });

  it("accepts git's own patches for names it quotes or ends with a tab, and for binary files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "darnit-plan-git-"));
    temp.push(dir);
    const names = ["sp ace.js", 'q"uo\\te.js', "t\tab.js", "d\u007fe\u0001l y.js", "café.js", "bin.js", "two hunks.js"];
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    await git(dir, ["init", "-q"]);
    await writeFile(join(dir, ".gitattributes"), "bin.js -diff\n");
    for (const n of names) await writeFile(join(dir, n), n === "two hunks.js" ? long : "a\n");
    await git(dir, ["add", "."]);
    await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "i"]);
    for (const n of names) await writeFile(join(dir, n), n === "two hunks.js" ? long.replace("line 1\n", "one\n").replace("line 19", "last") : "b\n");
    const patch = await gitPatch(dir, names);
    expect(patch).toContain("GIT binary patch");
    expect(patch).toContain("--- a/sp ace.js\t\n");
    expect(patch).toContain('diff --git "a/d\\177e\\001l y.js" "b/d\\177e\\001l y.js"');
    expect(patch).toContain("\\ No newline at end of file");
    expect(patch.match(/^@@/gm)?.length).toBe(names.length);
    expect(parsePlan(text(group({ files: names, patch })), ids).groups[0]!.files).toEqual(names);
  });

  it("rejects a field given twice, which JSON.parse would quietly read as the last one", () => {
    const plan = text(valid());
    expect(() => parsePlan(plan.replace('{"version":1,', '{"version":1,"version":1,'), ids)).toThrow('plan holds the field "version" twice');
    expect(() => parsePlan(plan.replace('"build":null,', '"build":null,"build":null,'), ids)).toThrow('plan holds the field "build" twice');
    // The same text inside a string is no field.
    const quoted = PATCH.replace("+max_completion_tokens=5", '+x = {"a": 1, "a": 2}');
    expect(parsePlan(text(group({ patch: quoted })), ids).groups[0]!.patch).toBe(quoted);
  });

  it("never repeats more than a short, escaped piece of the plan in its errors", () => {
    const errorOf = (plan: unknown) => {
      try {
        parsePlan(typeof plan === "string" ? plan : text(plan), ids);
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error("accepted");
    };
    const messages = [
      errorOf({ ...valid(), "\n::warning::pwned\u2028\u0085": 1 }),
      errorOf({ ...valid(), ["k".repeat(7 * 1024 * 1024)]: 1 }),
      errorOf(group({ id: "openai:2024-01-01:x\n::error::pwned\u0085" })),
      errorOf(text(valid()).replace('{"version":1,', '{"\\n::warning::x":1,"\\n::warning::x":1,"version":1,')),
      errorOf({ ...valid(), groups: Array.from({ length: 20 }, () => ({ ...valid().groups[0], [`\n::x${"y".repeat(100)}`]: 1 })) }),
    ];
    for (const m of messages) {
      expect(m.length).toBeLessThan(600);
      // eslint-disable-next-line no-control-regex
      expect(m.split("\n").every((line) => !line.includes("::") || !/^::|[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(line))).toBe(true);
    }
    expect(messages[0]).toContain('unknown field "\\n::warning::pwned\\u2028\\u0085"');
    expect(messages[1]).toMatch(/^invalid plan:\nplan: unknown field "k{64}…"$/);
    expect(messages[4]).toContain("and 15 more");
  });

  it("writes no plan it would refuse to read", () => {
    expect(() => serializePlan({ ...valid(), darnit: "x".repeat(CAPS.darnit + 1) }, ids)).toThrow(/over the cap/);
    expect(() => serializePlan(valid(), new Set())).toThrow(/does not have/);
  });
});
const temp: string[] = [];
afterAll(() => Promise.all(temp.map((d) => rm(d, { recursive: true, force: true }))));
