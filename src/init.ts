import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { detectApis, VENDORS } from "./detect.js";

const WORKFLOW = `name: darnit

on:
  schedule:
    - cron: "17 6 * * *"
  workflow_dispatch: {}

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx darnit check
`;

/** Writes `text` to root/rel unless it already exists. Returns the log line. */
async function place(root: string, rel: string, text: string, force: boolean): Promise<string> {
  const path = join(root, rel);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, text, { flag: force ? "w" : "wx" });
    return `${force ? "Rewrote" : "Wrote"} ${rel}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return `${rel} exists, left unchanged (--force to rewrite)`;
  }
}

/** `darnit init`: detect APIs, write darnit.yml and the scheduled workflow. Returns log lines. */
export async function init(root: string, { force = false } = {}): Promise<string[]> {
  const found = await detectApis(root);
  const summary =
    found.length === 0
      ? "Scanned repo: no known APIs found (the scheduled check still runs)"
      : `Scanned repo: found ${found.map((f) => `${f.vendor} (${f.evidence[0]}${VENDORS[f.vendor].tier === "recognized" ? "; recognized only" : ""})`).join(", ")}`;

  const config = {
    version: 1,
    apis: Object.fromEntries(found.map((f) => [f.vendor, { tier: VENDORS[f.vendor].tier, evidence: f.evidence }])),
  };
  const yml = `# darnit configuration (https://darnit.sh)\n# tier: supported = rule packs exist; recognized = named only, no change records yet; request support on GitHub\n${stringify(config)}`;

  return [summary, await place(root, "darnit.yml", yml, force), await place(root, ".github/workflows/darnit.yml", WORKFLOW, force)];
}
