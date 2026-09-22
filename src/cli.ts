#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { check, render } from "./check.js";
import { init } from "./init.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

// Exit codes: 0 nothing to report, 1 affected call sites found, 2 darnit itself failed.
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
  .action(async () => {
    const hits = await check(process.cwd());
    console.log(render(hits));
    if (hits.length > 0) process.exitCode = 1;
  });

program
  .command("fix")
  .description("apply a verified migration and show the diff")
  .action(() => {
    console.error("darnit fix: not implemented yet");
    process.exitCode = 2;
  });

try {
  await program.parseAsync();
} catch (err) {
  console.error(`darnit: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
}
