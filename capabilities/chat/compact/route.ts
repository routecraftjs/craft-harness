import { llm } from "@routecraft/ai";
import { craft, direct, jsonl, only } from "@routecraft/routecraft";
import { z } from "zod";
import { emptyWhenMissing } from "../../../shared/recover.js";
import { modelId } from "../../../env.js";
import {
  SESSION_HEADER,
  SessionId,
  TranscriptTurn,
  parseTurns,
  transcriptFileOf,
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
 * file. Two rules on top of that: the result must have turns, and it must
 * not be longer than what it replaced. Both exist because the failure being
 * guarded against is a compaction that silently destroys a conversation,
 * and a transcript file has no undo.
 */

const BEFORE_HEADER = "harness.compact.before";

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
  .error(emptyWhenMissing)
  .enrich(
    jsonl({ path: transcriptFileOf }),
    only((lines: unknown[]) => lines, "lines"),
  )
  .header(BEFORE_HEADER, (exchange) => parseTurns(exchange.body.lines).length)
  .transform((body) => {
    const turns = parseTurns(body.lines);
    const conversation = turns
      .map((entry) => `[${entry.at}] ${entry.role}: ${entry.text}`)
      .join("\n");
    return body.guidance === undefined
      ? conversation
      : `Keep in particular: ${body.guidance}\n\n${conversation}`;
  })
  .enrich(llm(modelId, { system: COMPACT_SYSTEM, output: Compacted }))
  .transform((result) => result.output?.turns ?? [])
  .filter((exchange) => {
    const before = Number(exchange.headers[BEFORE_HEADER] ?? 0);
    if (exchange.body.length === 0) {
      return {
        reason: "the model returned no turns; the transcript is left alone",
      };
    }
    if (exchange.body.length >= before) {
      return {
        reason: "the result was no shorter; the transcript is left alone",
      };
    }
    return true;
  })
  .tap(jsonl({ path: transcriptFileOf, createDirs: true }))
  .transform((turns, exchange) => ({
    session: String(exchange.headers[SESSION_HEADER] ?? ""),
    before: Number(exchange.headers[BEFORE_HEADER] ?? 0),
    after: turns.length,
  }));
