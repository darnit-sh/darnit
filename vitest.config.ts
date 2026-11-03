import { defineConfig } from "vitest/config";
// Line and branch percent per folder of src/; scripts/check-coverage.sh fails a change that lowers one or edits this file.
import thresholds from "./coverage-thresholds.json" with { type: "json" };

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/no-credentials.ts"],
    // Room for tests that start git, npm or ast-grep on a busy machine; timing tests set their own budgets.
    testTimeout: 30_000,
    tags: [{ name: "cpu-time", description: "Measures CPU time, so CI runs it without coverage, which slows the code it times." }],
    // Measured with --coverage, which CI passes on one runner.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds,
    },
  },
});
