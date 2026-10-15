#!/usr/bin/env node
import { once } from "node:events";
import { createRequire } from "node:module";
import { Command, CommanderError } from "commander";
import { checkJson, checkReport, exitCodeForCheck, render } from "./check.js";
import { exitCodeFor, fix, forTerminal, renderSummary, toJson as fixToJson } from "./fix.js";
import { init } from "./init.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

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
  .option("--force", "rewrite darnit.yml and the workflow if they exist")
  .action(async ({ force }: { force?: boolean }) => {
    for (const line of await init(process.cwd(), { force: force ?? false })) console.log(`✓ ${line}`);
  });

program
  .command("check")
  .description("report vendor API changes that affect this repo's call sites")
  .option("--json", "machine-readable output")
  .option("--mentions", "list every line that mentions a retired or retiring model name")
  .action(async ({ json, mentions: all }: { json?: boolean; mentions?: boolean }) => {
    const { hits, coverage, values, mentions } = await checkReport(process.cwd());
    if (json) {
      const out = process.stdout;
      // A reader that stops early (`| head`) ends the report quietly, as with console.log.
      out.on("error", () => {});
      const report = checkJson({ version, scanned: coverage }, { hits, possiblyAffected: values, mentions });
      for (const chunk of report) {
        if (out.destroyed) break;
        if (!out.write(chunk)) await once(out, "drain").catch(() => {});
      }
      out.write("\n");
    } else console.log(forTerminal(render(hits, coverage, values, mentions, all)));
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
      if (result.diff) console.log(forTerminal(result.diff, true));
      console.log(forTerminal(renderSummary(result)));
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
