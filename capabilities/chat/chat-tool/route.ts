import { mcp } from "@routecraft/ai";
import { craft, direct } from "@routecraft/routecraft";
import { ChatInput, ChatReply } from "../chat/route.js";

/**
 * The same conversation, over MCP.
 *
 * A route has exactly one ingress, so reaching chat from an assistant needs
 * a second one. This is the whole of it: accept the MCP call, forward to
 * `chat`, return what it returns. The conversation, the transcript and the
 * agent all stay in one place, and this file has nothing to drift from.
 *
 * Connect an assistant to `http://localhost:<MCP_PORT>/mcp` and it can hold
 * the same session a person holds with `craft exec chat`.
 */
export default craft()
  .id("chat-tool")
  .description("Send a message to the agent and get its reply.")
  .input({ body: ChatInput })
  .output({ body: ChatReply })
  .from<ChatInput>(
    mcp({ annotations: { readOnlyHint: false, destructiveHint: false } }),
  )
  .enrich(direct<ChatInput, ChatReply>("chat"));
