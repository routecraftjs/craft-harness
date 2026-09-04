import { type AgentResult, agent } from "@routecraft/ai";
import { craft, direct, only } from "@routecraft/routecraft";
import { z } from "zod";
import {
  SESSION_HEADER,
  SessionId,
  type TranscriptOp,
  type TranscriptResult,
  renderPrompt,
  turn,
} from "../../../shared/transcript.js";

/**
 * Talk to the agent, one message at a time, with the conversation kept on
 * disk.
 *
 * The whole of chat is this route: read the session's transcript, record
 * what was just said, dispatch the agent seeded with the conversation,
 * append the answer, return it. There is no chat subsystem and no
 * `craft chat` command, because what chat needs to be is a route that a
 * person, an assistant and a schedule can all reach.
 *
 * Those three callers reach it the same way, through this route's own
 * pre-from chain: `craft exec chat` over the ops door, the `chat-tool`
 * capability over MCP, and `scheduler-tick` in process. Nothing about the
 * conversation lives in a caller.
 *
 * The transcript is written twice on purpose. The user's turn lands before
 * the model is asked anything, so a dispatch that fails still leaves the
 * question in the file; the answer is appended after. Both writes go through
 * `transcript-owner`, which holds the file's lock for the whole of each one,
 * so a compaction running at the same time cannot write back a conversation
 * that never had this exchange in it.
 *
 * The agent's own definition, its system prompt, tools and skills, is
 * `agents/aria.md`; the body reaching `agent("aria")` is its user message.
 *
 * @example
 * ```bash
 * craft exec chat --session=demo --message="what can you do?"
 * ```
 */

export const ChatInput = z.object({
  session: SessionId.describe(
    "Conversation to continue. Any stable string; one transcript file each.",
  ),
  message: z.string().min(1).describe("What to say to the agent."),
});
export type ChatInput = z.infer<typeof ChatInput>;

/** What a caller gets back. */
export const ChatReply = z.object({
  session: z.string(),
  reply: z.string(),
});
export type ChatReply = z.infer<typeof ChatReply>;

export default craft()
  .id("chat")
  .description("Send a message to the agent and get its reply.")
  .input({ body: ChatInput })
  .from<ChatInput>(direct())
  .header(SESSION_HEADER, (exchange) => exchange.body.session)
  // The owner appends and answers with the conversation as it now stands, so
  // what the model is shown is what is on disk rather than what this route
  // believed a moment earlier.
  .transform((body): TranscriptOp => ({
    op: "append",
    session: body.session,
    turns: [turn("user", body.message)],
  }))
  .enrich(
    direct<TranscriptOp, TranscriptResult>("transcript-owner"),
    only((result: TranscriptResult) => result, "result"),
  )
  .transform((body) =>
    renderPrompt(
      body.result.turns.slice(0, -1),
      body.result.turns[body.result.turns.length - 1]?.text ?? "",
    ),
  )
  .enrich(agent("aria"))
  .transform((result: AgentResult, exchange): TranscriptOp => ({
    op: "append",
    session: String(exchange.headers[SESSION_HEADER] ?? ""),
    turns: [turn("assistant", result.text)],
  }))
  .enrich(
    direct<TranscriptOp, TranscriptResult>("transcript-owner"),
    only((result: TranscriptResult) => result, "result"),
  )
  .transform((body, exchange): ChatReply => ({
    session: String(exchange.headers[SESSION_HEADER] ?? ""),
    reply: body.result.turns[body.result.turns.length - 1]?.text ?? "",
  }));
