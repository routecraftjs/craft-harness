import { craft, direct, jsonl, only } from "@routecraft/routecraft";
import { emptyWhenMissing } from "../../../shared/recover.js";
import type { Exchange } from "@routecraft/routecraft";
import {
  SESSION_HEADER,
  TranscriptOp,
  type TranscriptOutcome,
  type TranscriptResult,
  applyTranscriptOp,
  transcriptFile,
  transcriptFileOf,
} from "../../../shared/transcript.js";

const OUTCOME = "harness.transcript.outcome";

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
 * `chat` appends the question, dispatches, and appends the answer.  `compact`
 * reads the whole conversation, spends a model call on it, and writes a
 * shorter one back. Both are read-modify-write against the same file, and the
 * model call in the middle of compact's cycle makes its window seconds wide:
 * two turns arriving in that window were read by nobody and overwritten by
 * the compaction that did not know about them.
 *
 * So the file has an owner, and the checks that decide whether a write is
 * safe happen here, inside the lock, against the file as it actually is. A
 * caller that read the file and decided for itself would be deciding about a
 * conversation that no longer exists.
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
  .concurrency({
    max: 1,
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
  .transform(
    (_body, exchange) => (exchange.headers[OUTCOME] as TranscriptOutcome).keep,
  )
  // A refused operation still lands here, writing back exactly what was read,
  // which is the same file. Branching to skip the write would buy nothing and
  // cost the one property worth having: whatever happens, the file on disk is
  // what this route decided under its lock.
  //
  // `.to()`, never `.tap()`. A tap is detached by contract: the framework runs
  // it on a tracked task and the pipeline continues immediately, so the route
  // answers its caller before the file has been written and the next read sees
  // the state before this one. That defeats the lock above, which can only
  // serialise work the route actually waits for.
  .to(jsonl({ path: transcriptFileOf, createDirs: true }))
  .transform((turns, exchange): TranscriptResult => {
    const outcome = exchange.headers[OUTCOME] as TranscriptOutcome;
    return {
      turns,
      before: outcome.before,
      written: outcome.written,
      refused: outcome.refused,
    };
  });
