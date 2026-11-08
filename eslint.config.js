import js from "@eslint/js";
import regexp from "eslint-plugin-regexp";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "node_modules/", "coverage/", "packs/**/fixtures/**", "test/samples/**", "test/e2e/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  // Fails the super-linear backtracking and moves the plugin can prove, and alternatives that overlap, which can
  // make a regex exponential. Some exponential forms, such as /^(a|aa)+$/, pass all three.
  {
    plugins: { regexp },
    rules: {
      "regexp/no-super-linear-backtracking": "error",
      "regexp/no-super-linear-move": "error",
      "regexp/no-dupe-disjunctions": ["error", { report: "all" }],
    },
  },
  {
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
