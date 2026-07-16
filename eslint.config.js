import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "**/*.config.js", "**/*.config.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, chrome: "readonly" },
    },
    // Only the two classic react-hooks rules: rules-of-hooks catches genuine bugs;
    // exhaustive-deps stays advisory. The v7 "recommended" set also ships new
    // React-Compiler-era style rules (set-state-in-effect, refs) as errors — those
    // would demand effect refactors, not lint fixes, so they're deliberately off.
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // The codebase uses intentional empty catches and a few pragmatic casts.
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
