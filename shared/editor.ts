import { hasSurface } from "@routecraft/ai";
import type { Exchange } from "@routecraft/routecraft";
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
 * What is deliberately NOT here is the command allowlist. That is the one
 * guardrail an operator changes to widen what a model may do without being
 * asked, and it belongs in the route whose behaviour it decides. Path rules
 * live in `shared/editor-paths.ts` because they are one rule with several
 * branches, applied by three routes in their `.input()`.
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

/**
 * Lines `read-file` asks the editor for, so the cap costs one message.
 *
 * `ReadTextFileRequest` carries an optional `limit` in lines, which is the
 * only bound the protocol offers. It is the first of two: a file of very long
 * lines passes this and is still refused by `FILE_CHARACTER_LIMIT`.
 */
export const FILE_LINE_LIMIT = 2_000;

/** Matches at most this many lines, so one search cannot fill a turn. */
export const SEARCH_MATCH_LIMIT = 200;

/**
 * Say there is no editor, in the words the person reading the reply needs.
 *
 * Every capability here can be reached from a schedule or from `craft exec`,
 * where nothing is connected. That is a configuration mismatch rather than a
 * fault, and the agent should be told so rather than shown a protocol error.
 *
 * An editor that IS connected but does not implement the call a capability
 * needs is a different refusal, and it is not this one: the ACP adapter
 * checks the advertised client capabilities and refuses naming the method
 * before the route's own call goes out.
 */
export function editorCannot(what: string): string {
  return (
    `No editor is connected to this turn, so ${what} is not available here. ` +
    `Everything else still works.`
  );
}

/**
 * Text fit for a dialogue the person reads, from something a model chose.
 *
 * Every permission prompt this harness raises is titled with model-supplied
 * text, and that prompt is the whole boundary for anything the allowlist does
 * not cover. So the text is stripped of what can compose a different
 * dialogue: control characters, the unicode line separators JSON escaping
 * leaves alone, and the bidirectional overrides that reorder what is on
 * screen. The cap stops a long argument scrolling the real question out of
 * whatever the editor renders.
 */
export function readable(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ")
    .slice(0, 300);
}

/**
 * Refuse before calling out, when there is no editor to call.
 *
 * One line per route rather than a five-line block per route: the guardrail
 * worth reading in a route body is the one that decides what the capability
 * may do, and this is the precondition that it can do anything at all.
 */
export function requireEditor(exchange: Exchange<unknown>, what: string): void {
  if (!hasSurface(exchange)) throw new Error(editorCannot(what));
}
