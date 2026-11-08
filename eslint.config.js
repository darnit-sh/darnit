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
  // A regex that can backtrack for a time that grows faster than its input hangs on crafted text.
  {
    plugins: { regexp },
    rules: { "regexp/no-super-linear-backtracking": "error", "regexp/no-super-linear-move": "error" },
  },
  {
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
