import { readPage, replacementsFor } from "../src/corpus/replacements.js";
import { parseChangeRecord } from "../src/records/schema.js";

// Run by test/replacements.test.ts in a child it can time out: m-0 and a-0 to a-(n-1) each offer all n ids.
const n = Number(process.argv[2]);
const ids = Array.from({ length: n }, (_, i) => `a-${i}`);
const offer = `${ids.slice(0, -1).join(", ")}, or ${ids.at(-1)}`;
const rows = [`m-0 || ${offer}`, ...ids.map((id) => `${id} || ${offer}`)];
const page = readPage(
  `<table><tr><th>Shutdown date</th><th>Model</th><th>Recommended replacement</th></tr>${rows.map((r) => `<tr><td>2026</td><td>${r.split(" || ").join("</td><td>")}</td></tr>`).join("")}</table>`,
);
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
    detection: { astGrepPatterns: { js: [{ context: '({ model: "m-0" })', selector: "pair" }] } },
  },
  "one.json",
);
console.log(JSON.stringify(replacementsFor([record], page, new Set()).problems));
