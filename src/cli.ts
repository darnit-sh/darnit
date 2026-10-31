#!/usr/bin/env node
import { once } from "node:events";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { checkJson, checkReport, exitCodeForCheck, render } from "./check.js";
import { exitCodeFor, fix, forJson, forTerminal, renderSummary, toJson as fixToJson } from "./fix.js";
import { init } from "./init.js";
import { updateNotice } from "./update.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const DIR = "the repository's folder (default: the current folder)";

/** The folder a command works on, as an absolute path; the current folder when none is given. An empty path,
 * as from an unset variable in a workflow, is refused rather than read as the current folder. */
async function folder(dir = process.cwd()): Promise<string> {
  const abs = resolve(dir);
  if (!dir.trim() || !(await stat(abs).catch(() => undefined))?.isDirectory()) throw new Error(`${dir.trim() ? dir : `"${dir}"`} is not a folder`);
  return abs;
}

// Exit codes: 0 nothing to act on, 1 call sites of a reviewed or parser-verified change found, 2 darnit itself failed.
// process.exitCode (not process.exit) so a long report is fully flushed through a pipe.

// exitOverride throws instead of exiting, so a mistyped flag exits 2 like any other darnit failure
// instead of commander's 1, which would read as "affected call sites found".
const program = new Command()
  .name("darnit")
  .description("Your API integrations, invisibly mended.")
  .version(version)
  .exitOverride();

program
  .command("init")
  .description("detect the APIs this repo uses and install the scheduled check")
  .argument("[dir]", DIR)
  .option("--force", "rewrite darnit.yml and the workflow if they exist and are committed as they are")
  .action(async (dir: string | undefined, { force }: { force?: boolean }) => {
    const lines = await init(await folder(dir), { force: force ?? false });
    console.log(forTerminal(lines.map((line) => (line.startsWith("Not checked:") ? line : `✓ ${line}`)).join("\n")));
  });

program
  .command("check")
  .description("report vendor API changes that affect this repo's call sites")
  .argument("[dir]", DIR)
  .option("--json", "machine-readable output")
  .option("--mentions", "list every line that mentions a retired or retiring model name")
  .action(async (dir: string | undefined, { json, mentions: all }: { json?: boolean; mentions?: boolean }) => {
    const root = await folder(dir);
    const update = updateNotice(version, { env: process.env, json });
    const { hits, coverage, values, mentions } = await checkReport(root);
    if (json) {
      const out = process.stdout;
      // A reader that stops early (`| head`) ends the report quietly, as with console.log.
      out.on("error", () => {});
      const report = checkJson({ version, scanned: coverage }, { hits, possiblyAffected: values, mentions });
      for (const chunk of report) {
        if (out.destroyed) break;
        if (!out.write(forJson(chunk))) await once(out, "drain").catch(() => {});
      }
      out.write("\n");
    } else {
      console.log(forTerminal(render(hits, coverage, values, mentions, all)));
      const notice = await update;
      if (notice) console.log(notice);
    }
    process.exitCode = exitCodeForCheck(hits);
  });

type FixFlags = { dryRun?: boolean; pr?: boolean; allowDirty?: boolean; repo?: string; only?: string[]; test?: string | false; json?: boolean; prepare?: string };

program
  .command("fix")
  .description("apply the rewrite for each affected change, run your tests, show the diff")
  .argument("[dir]", DIR)
  .option("--dry-run", "show what would change without writing anything")
  .option("--pr", "commit on a branch, push, and open one pull request per change")
  .option("--prepare <dir>", "verify each change as --pr does, then write a plan to <dir> instead of committing; refuses to run with GITHUB_TOKEN or GH_TOKEN set")
  .option("--allow-dirty", "let --pr or --prepare run with uncommitted changes present")
  .option("--repo <owner/name>", "GitHub repository, when origin is not a GitHub URL")
  .option("--only <id>", "restrict to one change record (repeatable)", (id: string, all: string[] = []) => [...all, id])
  .option("--test <command>", "run this instead of the detected test command")
  .option("--no-test", "skip tests and the build check")
  .option("--json", "machine-readable output")
  .action(async (dir: string | undefined, flags: FixFlags) => {
    const plan = flags.prepare;
    if (plan !== undefined && (!plan.trim() || plan.startsWith("-"))) throw new Error("--prepare needs the folder to write the plan to");
    if (plan !== undefined && flags.json) throw new Error("--prepare and --json can't be combined: the plan is the machine-readable output");
    const root = await folder(dir);
    const update = updateNotice(version, { env: process.env, json: flags.json });
    const result = await fix(root, {
      dryRun: flags.dryRun ?? false,
      pr: flags.pr ?? false,
      allowDirty: flags.allowDirty ?? false,
      noTest: flags.test === false,
      color: process.stdout.isTTY ?? false,
      version,
      ...(flags.repo ? { repo: flags.repo } : {}),
      ...(plan !== undefined ? { prepare: resolve(plan) } : {}),
      ...(flags.only ? { only: flags.only } : {}),
      ...(typeof flags.test === "string" ? { test: flags.test } : {}),
    });
    if (flags.json) console.log(forJson(JSON.stringify({ version, ...fixToJson(result) }, null, 2)));
    else {
      if (result.diff) console.log(forTerminal(result.diff, true));
      console.log(forTerminal(renderSummary(result)));
      const notice = await update;
      if (notice) console.log(notice);
    }
    process.exitCode = exitCodeFor(result);
  });

try {
  await program.parseAsync();
} catch (err) {
  if (err instanceof CommanderError) {
    // commander has already printed its message; --help and --version are not failures.
    process.exitCode = err.exitCode === 0 ? 0 : 2;
  } else {
    console.error(forTerminal(`darnit: ${err instanceof Error ? err.message : String(err)}`));
    process.exitCode = 2;
  }
}
