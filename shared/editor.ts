import { env } from "../env.js";

/**
 * The limits every editor capability applies, and the words it refuses in.
 *
 * These live together because they are one decision each rather than one per
 * route: how much output an editor may be asked to carry back, how large a
 * file the agent may pull into a turn, and how long a command may run. A
 * route reads the value from here and enforces it in its own body, where a
 * reader of that route can see it.
 *
 * What is deliberately NOT here is path containment or the command
 * allowlist. Those are guardrails rather than numbers, and the brief for
 * these capabilities is that each one carries its own visible: a rule
 * enforced in a helper nobody opens is one that can go missing without a
 * diff anybody reads.
 */

/**
 * Bytes of terminal output an editor is asked to retain per command.
 *
 * The client truncates, from the beginning, and tells us it did. 64KB is
 * enough for a test run's tail and small enough that one runaway command
 * cannot become the whole context window.
 */
export const OUTPUT_BYTE_LIMIT = 64_000;

/**
 * How long a command may run before it is killed and reported as timed out.
 *
 * From the environment rather than the model's input: a caller that can
 * raise its own deadline has no deadline, and an operator whose test suite
 * legitimately runs long should not have to edit a route to say so.
 */
export const COMMAND_TIMEOUT_MS = env.RUN_COMMAND_TIMEOUT_MS;

/**
 * Characters of a file the agent may read in one call.
 *
 * The editor reads the file, so the cost is a message on the wire and a
 * place in the turn's context rather than this process's memory. The cap is
 * about the second of those.
 */
export const FILE_CHARACTER_LIMIT = 100_000;

/** Matches at most this many lines, so one search cannot fill a turn. */
export const SEARCH_MATCH_LIMIT = 200;

/**
 * Say what is missing, in the words the person reading the reply needs.
 *
 * Every capability here can meet an editor that does not implement the call
 * it needs. That is a configuration mismatch rather than a fault, and the
 * agent should be told which capability the editor lacks rather than shown
 * a protocol error code.
 */
export function editorCannot(capability: string, what: string): string {
  return (
    `This editor does not offer ${capability}, so ${what} is not available ` +
    `here. Everything else still works.`
  );
}
