/**
 * Values that more than one file has to agree on, defined once.
 *
 * Everything here is read by `env.ts` (which turns it into a zod default),
 * by `craft.config.ts`, and by `scripts/setup.ts`. That last reader is the
 * reason this module exists and the reason it holds nothing but constants:
 * setup runs before `.env` exists, so it cannot import the parsed `env`
 * object, and its test copies it into a scratch directory to run it in
 * isolation. A module with no imports of its own survives both.
 *
 * The drift this closes is not hypothetical. Renaming the agent is one of
 * the first things somebody does to a scaffold, and with the name written
 * out in two places the config would change while setup kept writing the old
 * one into the editor profile, so the first prompt from JetBrains would be
 * refused by an instance that no longer holds that agent.
 */

/** The agent an editor conversation is answered by. */
export const EDITOR_AGENT = "aria";

/** The profile `craft acp` selects, and the name the printed entry carries. */
export const EDITOR_PROFILE = "editor";

/** Port defaults, one per surface. `.env` overrides any of them. */
export const DEFAULT_PORTS = {
  approvals: 8080,
  mcp: 8081,
  editor: 8082,
  ops: 9090,
} as const;
