// Flat ESLint config — works with ESLint ≥ 9.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: ["dist/**", "specs/**", "node_modules/**", "docs/api-reference/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        process: "readonly",
        Buffer: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        fetch: "readonly",
        Response: "readonly",
        Request: "readonly",
        Headers: "readonly",
        AbortController: "readonly",
        BodyInit: "readonly",
        RequestInfo: "readonly",
        RequestInit: "readonly",
        NodeJS: "readonly",
      },
    },
    rules: {
      // Allow underscore-prefix to mark intentionally-unused params/vars.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // We use `any` deliberately at the MCP SDK boundary; warn don't error.
      "@typescript-eslint/no-explicit-any": "warn",
      // Generated tool inputSchema casts to Record<string, unknown> — that's OK.
      "@typescript-eslint/no-unsafe-function-type": "off",
      // Allow `require()`-style imports in test bootstraps if needed.
      "@typescript-eslint/no-require-imports": "off",
      // We deliberately throw plain Error in some hot paths; class hierarchy isn't required everywhere.
      "@typescript-eslint/only-throw-error": "off",
    },
  },
  prettier, // last — turns off ESLint rules that Prettier handles.
];
