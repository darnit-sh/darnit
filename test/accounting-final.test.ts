import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml, stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { marked, notesSection, readCeiling, readNotCovered } from "../scripts/accounting-final.js";
import { parseSpec } from "../src/corpus/spec.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const tsx = join(ROOT, "node_modules", ".bin", "tsx");
// The fixture corpus has 4 items marked needs-record among its 9 items.
const FIXTURE = join(ROOT, "test", "fixtures", "accounting");
const CEILING = join("packs", "openai", "record-ceiling.txt");
const NOT_COVERED = join("packs", "openai", "not-covered.yaml");
const SPEC = join("corpus", "openai", "openapi.yaml");

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A copy of the fixture corpus with these files written into it (undefined leaves one out). */
async function corpus(files: Record<string, string | undefined> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "darnit-final-"));
  tempDirs.push(dir);
  await cp(FIXTURE, dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) if (text !== undefined) await writeFile(join(dir, file), text);
  return dir;
}

// Outside GitHub Actions, which fences the output with a token line at each end (its own test below), wherever this runs.
const local = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "GITHUB_ACTIONS"));

async function script(args: string[], env: NodeJS.ProcessEnv = local) {
  const run = await promisify(execFile)(tsx, ["scripts/accounting.ts", ...args], { cwd: ROOT, env }).then(
    (r) => ({ ...r, code: 0 }),
    (e: { stdout: string; stderr: string; code: number }) => e,
  );
  return { stdout: run.stdout, stderr: run.stderr, status: run.code };
}
const accounting = (dir: string, ...args: string[]) => script(["--root", dir, ...args]);

const lastLine = (stdout: string) => stdout.trimEnd().split("\n").at(-1);
const passes = (says: string) => `final release passes, openai: ${says}`;
const refused = (says: string) => `final release refused, openai: ${says}`;
const at = (n: string) => `the ceiling of ${n} in packs/openai/record-ceiling.txt`;
/** What GitHub could still render in a Markdown line once code spans and backslash escapes are taken out. */
const live = (line: string) =>
  line
    .replace(/`[^`]*`/g, "")
    .replace(/\\[!-/:-@[-`{-~]/g, "")
    .match(/[<>@#&*_[\]()!|~`\\]/g) ?? [];
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** The fixture with its spec changed: written as JSON, which YAML reads too. */
async function withSpec(change: (props: Record<string, unknown>) => void) {
  const spec = parseSpec(await readFile(join(FIXTURE, SPEC), "utf8"));
  change(spec.components!.schemas!.CreateImageRequest!.properties!);
  return JSON.stringify(spec);
}

describe("npm run accounting --final", () => {
  it("fails above the ceiling and passes at or below it, naming both numbers", async () => {
    const [above, equal, below] = await Promise.all(
      ["3\n", "4\n", "5\n"].map(async (c) => accounting(await corpus({ [CEILING]: c }), "--final")),
    );
    expect([above!.status, lastLine(above!.stdout)]).toEqual([1, refused(`4 need a record, above ${at("3")}`)]);
    expect([equal!.status, lastLine(equal!.stdout)]).toEqual([0, passes(`4 need a record, at ${at("4")}`)]);
    expect([below!.status, lastLine(below!.stdout)]).toEqual([
      0,
      passes(`4 need a record, below ${at("5")}; lower it to 4`),
    ]);
  });

  it("fails on a ceiling that is missing, empty, negative, not a whole number or above every item", async () => {
    const bad = {
      missing: undefined,
      empty: "",
      negative: "-1\n",
      word: "four\n",
      decimal: "4.0\n",
      "leading zero": "04\n",
      spaced: " 4\n",
      "two lines": "4\n4\n",
      huge: `${"9".repeat(400)}\n`,
      "above the 9 items": "10\n",
    };
    const runs = await Promise.all(
      Object.values(bad).map(async (c) => accounting(await corpus({ [CEILING]: c }), "--final")),
    );
    expect(runs.map((r) => [r.status, lastLine(r.stdout)])).toEqual([
      [1, refused("packs/openai/record-ceiling.txt is missing")],
      ...Array.from({ length: 7 }, () => [
        1,
        refused("packs/openai/record-ceiling.txt does not hold one whole number"),
      ]),
      [1, refused("packs/openai/record-ceiling.txt holds a number too large to count to")],
      [1, refused(`${at("10")} is above all 9 items accounting reads`)],
    ]);
    // Up to the ceiling itself, a ceiling equal to every item is a number like any other.
    expect(await readCeiling(await corpus({ [CEILING]: "9\r\n" }), "openai")).toBe(9);
  });

  it("fails, and says so last, when the plain check fails though the open items are at the ceiling", async () => {
    // A deprecation the spec no longer marks leaves a stale entry, which fails the plain run.
    const spec = parseSpec(await readFile(join(FIXTURE, SPEC), "utf8"));
    delete spec.components!.schemas!.ImagesResponse!.properties!.status!.deprecated;
    const dir = await corpus({ [CEILING]: "4\n", [SPEC]: JSON.stringify(spec) });
    expect((await accounting(dir)).status).toBe(1);
    const run = await accounting(dir, "--final");
    expect([run.status, lastLine(run.stdout)]).toEqual([
      1,
      refused(`the accounting above failed; 4 need a record, at ${at("4")}`),
    ]);
  });

  it("is zero once every open item has a record or a reason", async () => {
    const swept = (await readFile(join(FIXTURE, NOT_COVERED), "utf8"))
      .replace(/^ {2}date: .*\n/gm, "")
      .replaceAll("needs-record:", "reason:");
    const dir = await corpus({ [CEILING]: "0\n", [NOT_COVERED]: swept });
    const notes = join(dir, "notes.md");
    const run = await accounting(dir, "--final", "--notes", notes);
    expect([run.status, lastLine(run.stdout)]).toEqual([0, passes(`0 need a record, at ${at("0")}`)]);
    expect(await readFile(notes, "utf8")).toBe("## openai: 0 open, each needing a record\n\nNone.\n");
  });

  it("leaves the plain run as it was, whatever the ceiling file holds", async () => {
    const plain = await accounting(await corpus());
    expect(plain.status).toBe(0);
    for (const c of ["4\n", "garbage", "1\n"]) {
      const dir = await corpus({ [CEILING]: c });
      expect(await accounting(dir)).toEqual(plain);
      // --final prints the plain run's output, then its verdict.
      expect((await accounting(dir, "--final")).stdout.startsWith(plain.stdout.trimEnd())).toBe(true);
    }
  });

  it("exits 2 on a flag it does not know, a value on --final, a missing value, or --notes without --final", async () => {
    const dir = await corpus({ [CEILING]: "3\n" });
    const notes = join(dir, "notes.md");
    for (const args of [
      ["--final=true"],
      ["--Final"],
      ["--fianl"],
      ["final"],
      ["--final", "--notes"],
      ["--notes", "--final"],
      ["--notes", notes],
      ["--root"],
    ]) {
      const run = await accounting(dir, ...args);
      expect(run.status, args.join(" ")).toBe(2);
      expect(run.stdout, args.join(" ")).toMatch(/^accounting: "/);
      expect(run.stdout).not.toContain("deprecated in the spec");
    }
    await expect(readFile(notes)).rejects.toThrow("ENOENT");
    // --root=<dir> reads that folder: its 4 open items against its ceiling of 3.
    const inline = await script([`--root=${dir}`, "--final"]);
    expect([inline.status, lastLine(inline.stdout)]).toEqual([1, refused(`4 need a record, above ${at("3")}`)]);
  });

  it("writes the notes only on a pass, and only to a new file: an existing file or link is refused", async () => {
    const above = await corpus({ [CEILING]: "3\n" });
    const run = await accounting(above, "--final", "--notes", join(above, "notes.md"));
    expect([run.status, lastLine(run.stdout)]).toEqual([1, "No notes written: the final release is refused."]);
    await expect(readFile(join(above, "notes.md"))).rejects.toThrow("ENOENT");

    const dir = await corpus({ [CEILING]: "4\n", "old.md": "old notes\n" });
    await symlink(join(dir, "old.md"), join(dir, "link.md"));
    await symlink(join(dir, "nowhere.md"), join(dir, "dangling.md"));
    for (const name of ["old.md", "link.md", "dangling.md"]) {
      const file = join(dir, name);
      const refusal = await accounting(dir, "--final", "--notes", file);
      expect([refusal.status, lastLine(refusal.stdout)]).toEqual([
        1,
        `accounting stopped: ${JSON.stringify(`${file} already exists; the notes go only to a new file`)}`,
      ]);
    }
    expect(await readFile(join(dir, "old.md"), "utf8")).toBe("old notes\n");
    await expect(readFile(join(dir, "nowhere.md"))).rejects.toThrow("ENOENT");
  });

  it("in GitHub Actions, keeps each verdict the last line inside its fence, and the notes free of it", async () => {
    const actions = { ...local, GITHUB_ACTIONS: "true" };
    // The runner reads the first and last lines as commands; every line between shows in the log as text.
    const inside = (stdout: string) => {
      const lines = stdout.trimEnd().split("\n");
      const token = /^::stop-commands::([0-9a-f-]{36})$/.exec(lines[0]!)?.[1];
      expect(token, lines[0]).toBeDefined();
      expect(lines.at(-1)).toBe(`::${token}::`);
      expect(lines.slice(1, -1).filter((l) => l.startsWith("::"))).toEqual([]);
      return lines.slice(1, -1);
    };
    const above = await script(["--root", await corpus({ [CEILING]: "3\n" }), "--final"], actions);
    expect([above.status, inside(above.stdout).at(-1)]).toEqual([1, refused(`4 need a record, above ${at("3")}`)]);

    const dir = await corpus({ [CEILING]: "4\n" });
    const [fenced, plain] = [join(dir, "fenced.md"), join(dir, "plain.md")];
    const passed = await script(["--root", dir, "--final", "--notes", fenced], actions);
    expect([passed.status, inside(passed.stdout).at(-1)]).toEqual([0, passes(`4 need a record, at ${at("4")}`)]);
    expect((await accounting(dir, "--final", "--notes", plain)).status).toBe(0);
    expect(await readFile(fenced, "utf8")).toBe(await readFile(plain, "utf8"));
    expect(await readFile(fenced, "utf8")).not.toMatch(/stop-commands|^::/m);
  });

  it("writes the open items to the notes in the printed order, with no name able to forge a line or Markdown", async () => {
    const hostile = [
      "evil\n- forged\n## heading",
      "`code` *em* _u_ [a](javascript:x) <img src=x> &amp; | ~ \\ ! @someone #12 deadbeef1 :smile:",
      "‮rtl​\u0007",
    ];
    const entry = {
      items: hostile.map((n) => `schema CreateImageRequest property ${n}`),
      date: "2027-01-01",
      "needs-record": "Report-only.\n## forged [x](y) <b> @someone‮",
    };
    const dir = await corpus({
      [CEILING]: "7\n",
      [SPEC]: await withSpec((props) => {
        for (const name of hostile) props[name] = { type: "string", deprecated: true };
      }),
      [NOT_COVERED]: `${await readFile(join(FIXTURE, NOT_COVERED), "utf8")}\n${stringify([entry])}`,
    });
    const notes = join(dir, "notes.md");
    const run = await accounting(dir, "--final", "--notes", notes);
    expect(run.status).toBe(0);

    const lines = (await readFile(notes, "utf8")).split("\n");
    expect(lines.slice(0, 2)).toEqual(["## openai: 7 open, each needing a record", ""]);
    expect(lines.at(-1)).toBe("");
    const body = lines.slice(2, -1);
    // Every line is an entry or a key under it, with nothing GitHub would render and no hidden character.
    for (const line of body) {
      expect(line).toMatch(/^( {2})?- \S/);
      expect(live(line.replace(/^( {2})?- /, "")), line).toEqual([]);
      expect(line).not.toMatch(HIDDEN);
    }
    // The same keys in the same order as printed, read by their letters and digits.
    const words = (l: string) => l.replace(/[^A-Za-z0-9]/g, "");
    const printed = run.stdout.split("\n").filter((l) => /^ {6}"/.test(l));
    expect(body.filter((l) => l.startsWith("  - ")).map(words)).toEqual(printed.map(words));
    expect(printed).toContain('      "schema CreateImageRequest property evil\\n- forged\\n## heading"');
    expect(printed).toContain('      "schema CreateImageRequest property \\u202ertl\\u200b\\u0007"');
  });

  it("escapes the vendor heading, the entries and the keys, hidden characters included", () => {
    const lines = notesSection("@team <b>x</b> #1 [a](b)", [
      { head: "2027-01-01: a‮b\u0007c​d e *f* <i>", keys: ["k‮\u0000 <u>x</u> @me"] },
    ]);
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(live(line.replace(/^(## |- | {2}- )/, "")), line).toEqual([]);
      expect(line).not.toMatch(HIDDEN);
    }
  });

  it("holds each vendor's committed ceiling at the items its not-covered file marks needs-record", async () => {
    // Not the committed corpus, which a refresh changes: the ceiling and the not-covered file are both written by
    // hand, and while `npm run accounting` passes, the items marked needs-record are exactly the open ones. A
    // change that gives an open item a record or a reason lowers the ceiling with it; one that raises it shows here.
    const vendors = Object.keys(parseYaml(await readFile(join(ROOT, "vendors.yml"), "utf8")) as object);
    for (const vendor of vendors)
      expect([vendor, await readCeiling(ROOT, vendor)]).toEqual([vendor, marked(await readNotCovered(ROOT, vendor))]);
  });
});
