import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import routecraftPlugin from "@routecraft/eslint-plugin-routecraft";

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "workspace/**",
      "memory/**",
      "state/**",
    ],
  },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["capabilities/**/*.{ts,js}", "shared/**/*.{ts,js}"],
    plugins: { "@routecraft/routecraft": routecraftPlugin },
    ...routecraftPlugin.configs.recommended,
  },
  {
    files: ["**/*.test.{ts,js}", "**/*.spec.{ts,js}"],
    rules: { "@routecraft/routecraft/restrict-principal-minting": "off" },
  },
];
