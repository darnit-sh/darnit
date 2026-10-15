import { describe, expect, it } from "vitest";
import { lines } from "../scripts/golden.js";

const report = (file: string) => ({
  scanned: { files: 1, records: 2 },
  hits: [{ id: "r", file, line: 3, column: 4, text: "max_tokens: 5" }],
  possiblyAffected: [],
  mentions: [{ id: "r", file, line: 3, model: "gpt-4" }],
});

describe("golden result lines", () => {
  it("keeps one finding per line when a path holds a line break", () => {
    const out = lines(1, report("a\nM fake.py:1 gpt-4 x\u2028y\u0085.js"));
    expect(out.split("\n")).toHaveLength(5);
    expect(out).toContain('M "a\\nM fake.py:1 gpt-4 x\\u2028y\\u0085.js":3 gpt-4 r');
  });

  it("writes plain paths as they are, with a short hash of the matched code", () => {
    expect(lines(1, report("src/app.ts"))).toBe(
      ["exit 1", "scanned files=1 records=2 otherFiles=0 foreign=0 tooLarge=0 skipped=0", "H src/app.ts:3:4 #a4d75be4 r", "M src/app.ts:3 gpt-4 r", ""].join("\n"),
    );
  });
});
