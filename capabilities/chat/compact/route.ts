import { llm } from "@routecraft/ai";
import { craft, direct, only } from "@routecraft/routecraft";
import { z } from "zod";
import { modelId } from "../../../env.js";
import {
  SESSION_HEADER,
  SessionId,
  type TranscriptOp,
  type TranscriptResult,
  TranscriptTurn,
} from "../../../shared/transcript.js";

/**
 * Shorten a conversation without ending it.
 *
 * A long-running session eventually carries more history than the model
 * will accept, and the answer is to summarise the old part rather than to
 * start again. This is an ordinary tool: the agent can call it, a person can
 * run it with `craft exec`, and `schedule-task` can arrange it for later.
 * Nothing compacts automatically, because deciding a conversation has gone
 * on long enough is a judgement, not a threshold.
 *
 * The rewritten transcript replaces the old one under the same session id,
 * so the next `chat` call reads the shorter conversation with no handover.
 *
 * ## What is checked before the write
 *
 * The model is asked for a structured result and the schema is what
 * validates it, so a summary that came back as prose never reaches the
 * file. Three rules on top of that, and all three are enforced by
 * `transcript-owner` rather than here: the result must have turns, it must
 * not be longer than what it replaced, and the transcript must still hold the
 * same number of turns this route read. That last one is why they live there.
 * A model call takes seconds, and a turn arriving in that window would be
 * erased by a replacement computed before it existed; a check made here would
 * have passed while doing it. The failure being guarded against is a
 * compaction that silently destroys a conversation, and a transcript file has
 * no undo.
 *
 * A session with nothing in it is refused before the model is asked. It
 * cannot produce a shorter conversation than no conversation, so the call
 * would be spent to reach a refusal that was knowable for nothing.
 */

const BEFORE_HEADER = "harness.compact.before";

/**
 * The body is replaced by the transcript, then by the prompt, then by the
 * model's answer, so the caller's guidance has to travel outside it.
 */
const GUIDANCE_HEADER = "harness.compact.guidance";

export const CompactInput = z.object({
  session: SessionId.describe("Conversation to shorten."),
  guidance: z
    .string()
    .max(2_000)
    .optional()
    .describe("What to keep. Say what matters and it will be preserved."),
});
export type CompactInput = z.infer<typeof CompactInput>;

/** What the model must produce: a shorter conversation, same shape. */
const Compacted = z.object({
  turns: z
    .array(TranscriptTurn)
    .min(1)
    .describe("The shortened conversation, oldest first."),
});

const COMPACT_SYSTEM = [
  "You are compacting a conversation transcript so it fits in a smaller context.",
  "Return the same conversation, shorter: keep decisions, commitments, names, numbers, file paths and anything still open.",
  "Drop pleasantries, repetition, and any detail that has since been superseded.",
  "Preserve the alternating shape and the original timestamps of whichever turns you keep.",
  "Never invent a turn, and never drop the most recent exchange.",
].join(" ");

export default craft()
  .id("compact")
  .description("Shorten a conversation transcript, keeping what matters.")
  .input({ body: CompactInput })
  .timeout("2m")
  .from<CompactInput>(direct())
  .header(SESSION_HEADER, (exchange) => exchange.body.session)
  .header(GUIDANCE_HEADER, (exchange) => exchange.body.guidance ?? "")
  .transform((body): TranscriptOp => ({ op: "read", session: body.session }))
  .enrich(
    direct<TranscriptOp, TranscriptResult>("transcript-owner"),
    only((result: TranscriptResult) => result, "result"),
  )
  .header(BEFORE_HEADER, (exchange) => exchange.body.result.before)
  .filter((exchange) =>
    exchange.body.result.turns.length > 0
      ? true
      : { reason: "there is no conversation under that session to compact" },
  )
  .transform((body, exchange) => {
    const conversation = body.result.turns
      .map((entry) => `[${entry.at}] ${entry.role}: ${entry.text}`)
      .join("\n");
    const guidance = String(exchange.headers[GUIDANCE_HEADER] ?? "");
    return guidance === ""
      ? conversation
      : `Keep in particular: ${guidance}\n\n${conversation}`;
  })
  .enrich(llm(modelId, { system: COMPACT_SYSTEM, output: Compacted }))
  .transform((result, exchange): TranscriptOp => ({
    op: "replace",
    session: String(exchange.headers[SESSION_HEADER] ?? ""),
    turns: result.output?.turns ?? [],
    expect: Number(exchange.headers[BEFORE_HEADER] ?? 0),
  }))
  // The owner decides whether this replacement is still safe to write, against
  // the file as it is now rather than as it was before the model call.
  .enrich(
    direct<TranscriptOp, TranscriptResult>("transcript-owner"),
    only((result: TranscriptResult) => result, "result"),
  )
  .filter((exchange) =>
    exchange.body.result.written
      ? true
      : { reason: exchange.body.result.refused },
  )
  .transform((body, exchange) => ({
    session: String(exchange.headers[SESSION_HEADER] ?? ""),
    before: body.result.before,
    after: body.result.turns.length,
  }));
