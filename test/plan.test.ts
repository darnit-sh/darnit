import { describe, expect, it } from "vitest";
import { CAPS, parsePlan, serializePlan, type Plan } from "../src/plan.js";
import { loadRecords } from "../src/records/load.js";
import { cpuTime } from "./helpers.js";

const ids = new Set((await loadRecords()).map((l) => l.record.id));
const ID = [...ids][0]!;
const SHA = "a".repeat(40);
const PATCH = `diff --git a/app.py b/app.py\nindex ${"1".repeat(40)}..${"2".repeat(40)} 100644\n--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n-max_tokens=5\n+max_completion_tokens=5\n`;
const outcome = { command: "npm test", passed: true, attributed: null, notChecked: false, timedOut: false, output: "ok" };

const valid = (): Plan => ({ version: 1, darnit: "0.2.0", base: SHA, groups: [{ id: ID, files: ["app.py"], patch: PATCH, build: null, tests: { ...outcome } }] });
const text = (plan: unknown) => JSON.stringify(plan);
const group = (change: Record<string, unknown>) => ({ ...valid(), groups: [{ ...valid().groups[0], ...change }] });

describe("parsePlan", () => {
  it("accepts the plan darnit writes, and writes the same bytes whatever order its keys were set in", () => {
    const plan = valid();
    expect(parsePlan(serializePlan(plan, ids), ids)).toEqual(plan);
    const reordered = { groups: [{ tests: { ...outcome }, build: null, patch: PATCH, files: ["app.py"], id: ID }], base: SHA, darnit: "0.2.0", version: 1 } as const;
    expect(serializePlan(reordered as unknown as Plan, ids)).toBe(serializePlan(plan, ids));
  });

  it.each([
    ["the plan", { ...valid(), extra: 1 }],
    ["a group", group({ token: "x" })],
    ["a check", group({ tests: { ...outcome, env: "x" } })],
  ])("rejects an unknown field in %s", (_, plan) => {
    expect(() => parsePlan(text(plan), ids)).toThrow(/Unrecognized key/);
  });

  it.each([
    ["the patch", group({ patch: PATCH + "+".repeat(CAPS.patch) })],
    ["the test output", group({ tests: { ...outcome, output: "x".repeat(CAPS.output + 1) } })],
    ["the command", group({ tests: { ...outcome, command: "x".repeat(CAPS.command + 1) } })],
    ["the darnit version", { ...valid(), darnit: "x".repeat(CAPS.darnit + 1) }],
  ])("rejects %s over its cap", (_, plan) => {
    expect(() => parsePlan(text(plan), ids)).toThrow(/over the cap/);
  });

  it("rejects a whole plan over its cap before reading it", () => {
    expect(() => parsePlan(" ".repeat(CAPS.plan + 1), ids)).toThrow(`plan is over the cap of ${CAPS.plan} bytes`);
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
  ])("rejects a patch %s", (_, patch) => {
    expect(() => parsePlan(text(group({ patch })), ids)).toThrow(/patch is not a git diff of exactly these files/);
  });

  it("rejects a file listed that the patch does not change", () => {
    expect(() => parsePlan(text(group({ files: ["app.py", "b.py"] })), ids)).toThrow(/patch is not a git diff/);
  });

  it.each(["../app.py", "/etc/passwd", "a/../../app.py", ".git/config", "sub/.GIT/hooks/pre-commit", "a//b", "./app.py", "a\\b", 'a"b', "a\nb", ""])(
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
});
