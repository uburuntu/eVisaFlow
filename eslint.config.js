import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

const sharedIgnores = [
  "dist/**",
  "node_modules/**",
  "downloads/**",
  "snapshots/**",
  "tests/fixtures/**",
];

export default [
  {
    files: ["**/*.ts"],
    ignores: sharedIgnores,
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-undef": "off",
    },
  },
  {
    files: ["**/*.js"],
    ignores: sharedIgnores,
    languageOptions: {
      sourceType: "module",
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
];
