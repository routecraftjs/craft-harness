import { craft, direct, mail } from "@routecraft/routecraft";
import { z } from "zod";
import { env, mailEnabled } from "../../../env.js";

/**
 * Send a mail.
 *
 * Dormant until a mailbox is configured, and dormant in a way an operator
 * can see. `.enabled()` leaves the route registered and off: not started,
 * not connected, absent from the agent's tools, and reported by `/ops` as
 * disabled with the reason the predicate returned.
 *
 * The reason is the return value rather than a second argument, so the
 * sentence an operator reads always names the variables actually missing
 * instead of one somebody wrote once and stopped maintaining.
 *
 * That distinction is the whole point of the state. A route that is simply
 * absent looks the same as one that was never written, and only one of
 * those is a configuration a person can fix.
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

export default craft()
  .id("mail-reply")
  .description("Send an email.")
  .enabled(mailEnabled)
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
