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
    rules: {
      ...routecraftPlugin.configs.recommended.rules,
      // A tap is detached: the framework runs it on a tracked task and the
      // pipeline continues, so the route answers before the write lands and
      // the next read sees the state before it. Every write in this harness
      // used one once, and the failure is silent by construction, which is
      // why the rule is mechanical rather than a comment somebody has to
      // have read. A genuine observation takes a disable with a reason.
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='tap']",
          message:
            "A tap is detached: the route answers before the write lands. Use .to().",
        },
      ],
    },
  },
  {
    files: ["**/*.test.{ts,js}", "**/*.spec.{ts,js}"],
    rules: { "@routecraft/routecraft/restrict-principal-minting": "off" },
  },
];
