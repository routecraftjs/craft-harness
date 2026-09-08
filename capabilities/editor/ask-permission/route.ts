import { surface } from "@routecraft/ai";
import { type Exchange, craft, direct } from "@routecraft/routecraft";
import { z } from "zod";

/**
 * Ask the person, in the conversation they already have open.
 *
 * The harness already has an approvals capability, and it is the right shape
 * for something that has to outlive the asking: it parks the exchange, mails
 * a link, and resolves days later in a different process. That is the wrong
 * shape for "may I run this command", which the person is sitting in front
 * of and which is worthless five minutes later.
 *
 * So this asks through the editor. The person sees it in the conversation
 * they are already in, answers with a button, and the turn continues. The
 * two are not alternatives: `request-approval` is for a decision that
 * travels, and this is for a decision that does not.
 *
 * Internal, and that is intent's ruling rather than an implementation
 * detail: a model that can call the permission prompt directly can spend a
 * person's attention with it, and the guardrail is worth more as the only
 * path to a write than as one tool beside the write.
 *
 * ## Failing closed
 *
 * A refusal, a malformed answer, and an answer naming an option that was
 * never offered all arrive as the protocol's `cancelled` outcome. Only an
 * explicit selection of the allow option returns true, so every other
 * ending, including an editor that answers nonsense, denies.
 */

export const AskPermissionInput = z.object({
  title: z.string().min(1).describe("What the person is being asked to allow."),
  kind: z
    .enum(["execute", "edit", "delete", "fetch", "other"])
    .default("other")
    .describe("What sort of action it is, for the editor's own rendering."),
});
export type AskPermissionInput = z.infer<typeof AskPermissionInput>;

/** The option id that means yes. Anything else, or nothing, means no. */
const ALLOW = "allow";

/**
 * Put the question to the person and answer whether they said yes.
 *
 * Exported as a function because the capabilities that need it are asking
 * as part of their own work rather than dispatching a separate step, and
 * the answer has to come back before they decide what to do next.
 */
export async function askPermission(
  exchange: Exchange<unknown>,
  input: AskPermissionInput,
): Promise<boolean> {
  const answer = (await surface("session/request_permission", {
    toolCall: {
      toolCallId: `ask-${Date.now()}`,
      title: input.title,
      kind: input.kind,
    },
    options: [
      { optionId: ALLOW, name: input.title, kind: "allow_once" },
      { optionId: "deny", name: "No", kind: "reject_once" },
    ],
  }).fetch(exchange)) as { outcome: { outcome: string; optionId?: string } };

  return (
    answer.outcome.outcome === "selected" && answer.outcome.optionId === ALLOW
  );
}

export default craft()
  .id("ask-permission")
  .description("Ask the person in the editor to allow something.")
  .input({ body: AskPermissionInput })
  // Internal: reachable in process, absent from the ops dispatch door and
  // never offered to the model.
  .from<AskPermissionInput>(direct({ internal: true }))
  .transform(async (input, exchange) => ({
    allowed: await askPermission(exchange, input),
  }));
