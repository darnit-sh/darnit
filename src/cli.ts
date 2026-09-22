#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { check, render } from "./check.js";
import { init } from "./init.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

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
    process.exit(hits.length > 0 ? 1 : 0);
  });

program
  .command("fix")
  .description("apply a verified migration and show the diff")
  .action(() => notYet("fix"));

function notYet(command: string): never {
  console.error(`darnit ${command}: not implemented yet`);
  process.exit(2);
}

await program.parseAsync();
