// Stands in for `tsc --noEmit` on openai 4.20.0, whose types have no max_completion_tokens.
import { readFileSync } from "node:fs";

if (readFileSync("src/draft.ts", "utf8").includes("max_completion_tokens")) {
  console.error("src/draft.ts: Object literal may only specify known properties, and 'max_completion_tokens' does not exist.");
  process.exit(1);
}
