#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { checkReport, exitCodeForCheck, render, toJson } from "./check.js";
import { exitCodeFor, fix, renderSummary, toJson as fixToJson } from "./fix.js";
import { init } from "./init.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

// Exit codes: 0 nothing to act on, 1 call sites of a reviewed change found, 2 darnit itself failed.
// process.exitCode (not process.exit) so a long report is fully flushed through a pipe.

const program = new Command()
  .name("darnit")
  .description("Your API integrations, invisibly mended.")
  .version(version);

program
  .command("init")
  .description("detect the APIs this repo uses and install the scheduled check")
  .option("--force", "rewrite darnit.yml and the workflow if they exist")
  .action(async ({ force }: { force?: boolean }) => {
    for (const line of await init(process.cwd(), { force: force ?? false })) console.log(`✓ ${line}`);
  });

program
  .command("check")
  .description("report vendor API changes that affect this repo's call sites")
  .option("--json", "machine-readable output")
  .action(async ({ json }: { json?: boolean }) => {
    const { hits, coverage } = await checkReport(process.cwd());
    console.log(json ? JSON.stringify({ version, scanned: coverage, hits: toJson(hits) }, null, 2) : render(hits, coverage));
    process.exitCode = exitCodeForCheck(hits);
  });

type FixFlags = { dryRun?: boolean; pr?: boolean; allowDirty?: boolean; repo?: string; only?: string[]; test?: string | false; json?: boolean };

program
  .command("fix")
  .description("apply the rewrite for each affected change, run your tests, show the diff")
  .option("--dry-run", "show what would change without writing anything")
  .option("--pr", "commit on a branch, push, and open one pull request per change")
  .option("--allow-dirty", "let --pr run with uncommitted changes present")
  .option("--repo <owner/name>", "GitHub repository, when origin is not a GitHub URL")
  .option("--only <id>", "restrict to one change record (repeatable)", (id: string, all: string[] = []) => [...all, id])
  .option("--test <command>", "run this instead of the detected test command")
  .option("--no-test", "skip tests and the build check")
  .option("--json", "machine-readable output")
  .action(async (flags: FixFlags) => {
    const result = await fix(process.cwd(), {
      dryRun: flags.dryRun ?? false,
      pr: flags.pr ?? false,
      allowDirty: flags.allowDirty ?? false,
      noTest: flags.test === false,
      color: process.stdout.isTTY ?? false,
      version,
      ...(flags.repo ? { repo: flags.repo } : {}),
      ...(flags.only ? { only: flags.only } : {}),
      ...(typeof flags.test === "string" ? { test: flags.test } : {}),
    });
    if (flags.json) console.log(JSON.stringify({ version, ...fixToJson(result) }, null, 2));
    else {
      if (result.diff) console.log(result.diff);
      console.log(renderSummary(result));
    }
    process.exitCode = exitCodeFor(result);
  });

try {
  await program.parseAsync();
} catch (err) {
  console.error(`darnit: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
}
