import { readPage, replacementsFor } from "../src/corpus/replacements.js";
import { parseChangeRecord } from "../src/records/schema.js";

// Run by test/replacements.test.ts in a child it can time out: one row naming `k` detected models d-0 to d-(k-1)
// offers a-0 to a-(n-1), and each a-i offers all n. Prints the problems and the CPU milliseconds the work took.
const [n, k] = process.argv.slice(2).map(Number) as [number, number];
const list = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
const ids = list("a", n);
const offer = `${ids.slice(0, -1).join(", ")}, or ${ids.at(-1)}`;
const rows = [`${list("d", k).join(" | ")} || ${offer}`, ...ids.map((id) => `${id} || ${offer}`)];
const html = `<table><tr><th>Shutdown date</th><th>Model</th><th>Recommended replacement</th></tr>${rows.map((r) => `<tr><td>2026</td><td>${r.split(" || ").join("</td><td>")}</td></tr>`).join("")}</table>`;
const record = parseChangeRecord(
  {
    id: "openai:2026-01-01:one",
    status: "parser-verified",
    vendor: "openai",
    announcedAt: "2026-01-01",
    kind: "deprecation",
    surface: { sdkSymbols: ["responses.create"], fields: ["model"] },
    classification: "semantic",
    sources: [{ url: "https://developers.openai.com/api/docs/deprecations" }],
    detection: {
      astGrepPatterns: { js: list("d", k).map((d) => ({ context: `({ model: "${d}" })`, selector: "pair" })) },
    },
  },
  "one.json",
);
const start = process.cpuUsage();
const { problems } = replacementsFor([record], readPage(html), new Set());
const { user, system } = process.cpuUsage(start);
console.log(JSON.stringify({ bytes: html.length, problems, ms: (user + system) / 1000 }));
