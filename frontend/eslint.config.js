import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import sonarjs from "eslint-plugin-sonarjs";
import importX from "eslint-plugin-import-x";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import tseslint from "typescript-eslint";

// The frontend analog of the Go budgets in .golangci.yml. The thresholds are
// deliberately the same numbers: gocyclo <= 10 -> `complexity` <= 10, and
// gocognit <= 15 -> `sonarjs/cognitive-complexity` <= 15 (same algorithm).
// Coupling is gated with `import-x/no-cycle`: a cycle is tight coupling by
// definition, and it is the frontend's counterpart to depguard's layering.
//
// Ratchet: error-level rules run against the bulk-suppressions baseline in
// eslint-suppressions.json, so a NEW violation fails while a grandfathered one
// does not. Regenerate deliberately, never to silence a fresh finding:
//   npx eslint --suppress-rule complexity --suppress-rule sonarjs/cognitive-complexity
//   npx eslint --prune-suppressions
export default tseslint.config(
  {
    ignores: [
      "dist",
      // Wails generates these from the Go bindings (`wails generate module`);
      // they are build output that happens to be committed, not source.
      "wailsjs",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      sonarjs,
      "import-x": importX,
    },
    settings: {
      "import-x/resolver-next": [
        createTypeScriptImportResolver({ project: "./tsconfig.json" }),
      ],
      // no-cycle re-parses each imported module to find its own imports.
      // Without mapping .ts/.tsx to the TS parser that re-parse fails silently
      // and the return edge of a cycle is never seen — the rule fails open.
      "import-x/parsers": {
        "@typescript-eslint/parser": [".ts", ".tsx", ".cts", ".mts"],
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,

      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],

      // --- Complexity budget (mirrors the Go per-function gates) ---
      complexity: ["error", 10],
      "sonarjs/cognitive-complexity": ["error", 15],

      // --- Coupling / layering ---
      "import-x/no-cycle": ["error", { maxDepth: 4, ignoreExternal: true }],

      // --- Size / fan-out proxies (advisory: a signal to split, not a block) ---
      "max-lines": ["error", 600],
      "max-lines-per-function": [
        "warn",
        { max: 250, skipBlankLines: true, skipComments: true },
      ],
      "max-params": ["warn", 5],
      "import-x/max-dependencies": [
        "warn",
        { max: 25, ignoreTypeImports: true },
      ],

      // --- Copy-paste / dead-branch growth ---
      "sonarjs/no-identical-functions": "warn",
      "sonarjs/no-collapsible-if": "warn",
    },
  },
  {
    // Test files: fixtures repeat by nature and size budgets are noise there.
    files: ["**/*.test.{ts,tsx}"],
    rules: {
      "max-lines": "off",
      "max-lines-per-function": "off",
      "sonarjs/no-identical-functions": "off",
    },
  },
  {
    // The config files themselves are Node ESM, not browser source.
    files: ["*.config.{ts,js}", "eslint.config.js"],
    languageOptions: { globals: globals.node },
  },
);
