import { configDefaults, defineConfig } from "vitest/config";

// These start knip and jscpd, which keep every core busy; run beside the rest they starve its timing and hang guards.
const tools = ["test/allowlist.test.ts", "test/allowlist-run.test.ts"];

export default defineConfig({
  test: {
    setupFiles: ["test/no-credentials.ts"],
    // Room for tests that start git, npm or ast-grep on a busy machine; timing tests set their own budgets.
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: "suite",
          include: ["test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...tools],
          sequence: { groupOrder: 0 },
        },
      },
      { extends: true, test: { name: "tools", include: tools, sequence: { groupOrder: 1 } } },
    ],
  },
});
