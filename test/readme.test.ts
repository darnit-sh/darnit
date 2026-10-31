import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { WORKFLOW } from "../src/init.js";
import { matchersAtDarnit } from "./helpers.js";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const help = async (...args: string[]) =>
  (await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), cli, ...args, "--help"])).stdout;

// Each command's flags as the CLI prints them in --help; "" holds the program's own.
let flags: Map<string, string[]>;
beforeAll(async () => {
  const top = await help();
  const commands = [...top.split("Commands:")[1]!.matchAll(/^ {2}(\w+)/gm)].map((m) => m[1]!);
  const pages = await Promise.all(["", ...commands].map(async (c) => [c, c ? await help(c) : top] as const));
  flags = new Map(pages.map(([c, page]) => [c, [...page.matchAll(/^ {2}(?:(-\w), )?(--[\w-]+)/gm)].flatMap((m) => (m[1] ? [m[1], m[2]!] : [m[2]!]))]));
});

const read = (file: string) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

// Fenced block lines and inline code spans.
const code = (md: string) =>
  md.split(/^```.*$/m).flatMap((part, i) => (i % 2 ? [part] : [...part.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!)));

describe("docs match the CLI", () => {
  it.each(["README.md", "RELEASING.md"])("every darnit command line in %s uses a real command and its flags", async (file) => {
    const seen: string[] = [];
    const wrong: string[] = [];
    for (const piece of code(await read(file))) {
      for (const [line, rest] of piece.matchAll(/(?:^\s*(?:\$ )?|npx (?:-y |--yes )?)darnit(?:@[\w.-]+)?((?: +[\w-]+)+)/gm)) {
        seen.push(line);
        const words = rest!.trim().split(/ +/);
        const command = words[0]!.startsWith("-") ? "" : words[0]!;
        const known = flags.get(command);
        if (!known) wrong.push(line);
        else if (words.some((w) => w.startsWith("-") && !known.includes(w))) wrong.push(line);
      }
    }
    expect(seen).not.toEqual([]);
    expect(wrong).toEqual([]);
  });

  // Started inside the checkout, npx would run a darnit or an .npmrc setting from the repository (scripts/e2e.ts).
  it("the README workflow examples start npx outside the checkout, like the workflow init writes", async () => {
    const runs = (await read("README.md")).match(/^ *- run: .*npx .*$/gm);
    expect(runs).toHaveLength(2);
    for (const run of runs!) expect(run).toMatch(/- run: cd "\$\{RUNNER_TEMP:\?\}" && npx darnit (?:check|fix --pr) "\$\{GITHUB_WORKSPACE:\?\}"$/);
  });

  it("the README says what init --force does in the words of its --help", async () => {
    const row = /^\| `--force` \| (.*) \|$/m.exec(await read("README.md"))?.[1]?.replaceAll("`", "");
    const said = /^ {2}--force +([^]*?)\n {2}-/m.exec(await help("init"))?.[1]?.replace(/\s+/g, " ").trim();
    expect(said).toMatch(/committed/);
    expect(row).toBe(said);
  });

  it("the README shows the workflow init writes, and its fix --pr job also removes setup-node's problem matchers before darnit runs", async () => {
    const [check, pr] = [...(await read("README.md")).matchAll(/^```yaml\n([^]*?)^```$/gm)].map((m) => m[1]!);
    expect(check).toBe(WORKFLOW.replace(/npx darnit@\S+/, "npx darnit"));
    type Step = { uses?: string; run?: string };
    const steps = (parse(check!) as { jobs: { check: { steps: Step[] } } }).jobs.check.steps;
    expect(matchersAtDarnit(steps)).toEqual([]);
    const [, last] = pr!.split(/^# \.\.\.and the last step replaced with:\n/m);
    const prSteps = [...steps.slice(0, -1), ...(parse(last!) as Step[])];
    expect(prSteps.at(-1)?.run).toMatch(/npx darnit fix --pr/);
    expect(matchersAtDarnit(prSteps)).toEqual([]);
  });

  it("each command's README section lists exactly the flags the command has", async () => {
    const sections = (await read("README.md")).split(/^(?=#{2,3} )/m);
    const documented = new Map(
      sections.flatMap((s) => {
        const command = /^### `darnit (\w+)`/.exec(s)?.[1];
        return command ? [[command, [...new Set(s.match(/(?<![\w-])--[a-z][\w-]*/g))].sort()] as const] : [];
      }),
    );
    const real = [...flags].filter(([c]) => c && c !== "help").map(([c, f]) => [c, f.filter((x) => x.startsWith("--") && x !== "--help").sort()] as const);
    expect(documented).toEqual(new Map(real));
  });
});
