import { craft, direct, jsonl, only } from "@routecraft/routecraft";
import { emptyWhenMissing } from "../../../shared/recover.js";
import type { Exchange } from "@routecraft/routecraft";
import {
  SESSION_HEADER,
  TranscriptOp,
  type TranscriptResult,
  applyTranscriptOp,
  transcriptFile,
  transcriptFileOf,
} from "../../../shared/transcript.js";

const OUTCOME = "harness.transcript.outcome";

/**
 * The decision this exchange reached, which the body cannot carry because the
 * body has to become the array the write persists.
 *
 * Throws rather than asserting: a missing header means the step order changed,
 * and failing inside the lock is better than writing whatever `undefined`
 * parses to.
 */
function outcomeOf(exchange: Exchange<unknown>): TranscriptResult {
  const outcome = exchange.headers[OUTCOME];
  if (outcome === undefined) {
    throw new Error("transcript-owner: the outcome header was not set");
  }
  return outcome as TranscriptResult;
}

/**
 * The session an incoming operation names.
 *
 * The concurrency key is chosen before the route runs, so it reads the body
 * rather than the header the route sets from it. `.input()` has validated the
 * shape by the time a slot is taken.
 */
function sessionOfOp(exchange: Exchange<unknown>): string {
  return String((exchange.body as { session?: unknown }).session ?? "");
}

/**
 * The one route that reads and writes a session's transcript.
 *
 * `chat` appends the question, dispatches, and appends the answer. `compact`
 * reads the whole conversation, spends a model call on it, and writes a
 * shorter one back. Both are read-modify-write against the same file, so both
 * belong behind one lock.
 *
 * The checks that decide whether a write is safe run inside that lock, in
 * `applyTranscriptOp`, which carries the reasoning.
 *
 * The key is the session, so two people talking in different conversations do
 * not queue behind each other. Keying per route instead would let `chat` and
 * `compact` hold separate slots on the same file, which is the race this
 * exists to close.
 *
 * Internal because it is a lock, not a capability.
 */
export default craft()
  .id("transcript-owner")
  .description("Serialise every read and write of one session's transcript.")
  .input({ body: TranscriptOp })
  // The deadline sits outside the lock in the pre-from chain, so it bounds the
  // wait for a slot as well as the work. Without it a write that never returns
  // parks every caller for that conversation in an unbounded queue.
  .timeout("30s")
  .concurrency({
    max: 1,
    // A backlog this long means something is wrong upstream, and RC5026 tells
    // the caller so rather than growing the queue in silence.
    maxQueue: 100,
    // One slot per conversation. The file is the resource, and the session
    // names the file.
    key: (exchange) => transcriptFile(sessionOfOp(exchange)),
  })
  .from<TranscriptOp>(direct({ internal: true }))
  // The body is rewritten three times below and the path has to outlive all
  // of them, so which conversation this is travels in the header.
  .header(SESSION_HEADER, (exchange) => exchange.body.session)
  // A session with no file yet is a new conversation. Every other read failure
  // is declined, because the write below replaces the file whole.
  .error(emptyWhenMissing)
  .enrich(
    jsonl({ path: transcriptFileOf }),
    only((lines: unknown[]) => lines, "lines"),
  )
  .header(OUTCOME, (exchange) =>
    applyTranscriptOp(exchange.body, exchange.body.lines),
  )
  .transform((_body, exchange) => outcomeOf(exchange).turns)
  // `.to()`, not `.tap()`: a tap is detached and would answer before the write.
  // Gated on `written`, so a read and a refused replacement change nothing. A
  // read that wrote would drop the lines the parse rejects and would create a
  // transcript for a session that has none, which is what a mistyped
  // `--session` asks for.
  .to(async (exchange) => {
    if (!outcomeOf(exchange).written) return;
    await jsonl({ path: transcriptFileOf, createDirs: true }).send(exchange);
  })
  .transform((_written, exchange): TranscriptResult => outcomeOf(exchange));
