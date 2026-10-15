import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"], exclude: ["test/versions.test.ts", "**/node_modules/**"],
    // Room for tests that start git, npm or ast-grep on a busy machine; timing tests set their own budgets.
    testTimeout: 30_000,
  },
});
