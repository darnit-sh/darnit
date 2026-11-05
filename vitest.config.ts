import { defineConfig } from "vitest/config";
// Line and branch percent per folder of src/. Only a ci change may edit this file or the thresholds
// (scripts/check-refactor.sh), and lowering a threshold also takes a Coverage line (scripts/check-coverage.sh).
import thresholds from "./coverage-thresholds.json" with { type: "json" };

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/no-credentials.ts"],
    // Room for tests that start git, npm or ast-grep on a busy machine; timing tests set their own budgets.
    testTimeout: 120_000,
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
