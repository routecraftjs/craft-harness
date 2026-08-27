import { craft, direct, mail } from "@routecraft/routecraft";
import { z } from "zod";
import { env, mailConfigured } from "../../../env.js";

/**
 * Send a mail.
 *
 * Dormant until a mailbox is configured. `MAIL_ADDRESS` and
 * `MAIL_APP_PASSWORD` are the two values that decide it, and until both are
 * set this module exports no routes at all: the adapter is never
 * constructed, nothing connects, and the harness boots and passes CI with
 * no secrets anywhere.
 *
 * That is conditional construction rather than a runtime flag on purpose.
 * A route that exists and refuses is a route in the registry, in the ops
 * listing, and in the agent's tool surface, all describing something that
 * cannot work.
 */

export const MailReplyInput = z.object({
  to: z.email().describe("Who to write to."),
  subject: z.string().min(1).max(200).describe("Subject line."),
  text: z.string().min(1).describe("The message, in plain text."),
  inReplyTo: z
    .string()
    .optional()
    .describe(
      "Message-ID this answers, so it threads in the recipient's client.",
    ),
});
export type MailReplyInput = z.infer<typeof MailReplyInput>;

const mailReply = craft()
  .id("mail-reply")
  .description("Send an email.")
  .input({ body: MailReplyInput })
  .from<MailReplyInput>(direct())
  .transform((body) => ({
    to: body.to,
    from: env.MAIL_ADDRESS,
    subject: body.subject,
    text: body.text,
    ...(body.inReplyTo === undefined ? {} : { inReplyTo: body.inReplyTo }),
  }))
  .tap(mail())
  .transform((payload) => ({ to: payload.to, sent: true }));

export default mailConfigured ? [mailReply] : [];
