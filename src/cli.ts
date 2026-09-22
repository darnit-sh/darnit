#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command()
  .name("darnit")
  .description("Your API integrations, invisibly mended.")
  .version(version);

program
  .command("init")
  .description("detect the APIs this repo uses and install the scheduled check")
  .action(() => notYet("init", "M0"));

program
  .command("check")
  .description("report vendor API changes that affect this repo's call sites")
  .action(() => notYet("check", "M1"));

program
  .command("fix")
  .description("apply a verified migration and show the diff")
  .action(() => notYet("fix", "M2"));

function notYet(command: string, milestone: string): never {
  console.error(`darnit ${command}: not implemented yet (lands in ${milestone})`);
  process.exit(2);
}

await program.parseAsync();
