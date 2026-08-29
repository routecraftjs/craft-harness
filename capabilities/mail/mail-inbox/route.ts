import {
  type MailBody,
  MailHeaders,
  craft,
  direct,
  log,
  mail,
  only,
} from "@routecraft/routecraft";
import { env, mailEnabled } from "../../../env.js";
import type { ChatInput, ChatReply } from "../../chat/chat/route.js";
import type { MailReplyInput } from "../mail-reply/route.js";

/**
 * Read the mailbox and answer what arrives.
 *
 * Dormant until a mailbox is configured, by the same mechanism as
 * `mail-reply`: `.enabled()` leaves it registered and off, so no IMAP
 * connection is opened, the harness boots and passes CI with no secrets, and
 * `/ops` says which variables are missing rather than leaving an operator to
 * work out whether the route was ever written.
 *
 * Each correspondent gets their own conversation, keyed by address, so the
 * agent remembers someone between mails rather than meeting them fresh each
 * time. The message the model reads is assembled here from the body and the
 * `routecraft.mail.*` headers, which is where the mail source puts the
 * envelope.
 *
 * Nothing here decides WHO is allowed to talk to the agent. Point this at a
 * mailbox the public can reach and anyone who can send mail can drive the
 * agent. Put that rule in front of the dispatch (a `.filter()` on the
 * verified sender at minimum) before you do.
 */

/** Session id for a correspondent. The id becomes a filename. */
function sessionFor(address: string): string {
  return address.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 64) || "mail";
}

export default craft()
  .id("mail-inbox")
  .description("Answer mail that arrives in the configured mailbox.")
  .enabled(mailEnabled)
  .from(mail(env.MAIL_FOLDER, { markSeen: true }))
  .transform((body: MailBody, exchange): ChatInput & { replyTo: string } => {
    const from = exchange.headers[MailHeaders.FROM] ?? "";
    const subject = exchange.headers[MailHeaders.SUBJECT] ?? "";
    return {
      session: sessionFor(from),
      replyTo: from,
      message: `Mail from ${from}\nSubject: ${subject}\n\n${body.text ?? body.html ?? ""}`,
    };
  })
  .enrich(
    direct<ChatInput, ChatReply>("chat"),
    only((reply: ChatReply) => reply.reply, "reply"),
  )
  .transform((body, exchange): MailReplyInput => ({
    to: body.replyTo,
    subject: `Re: ${exchange.headers[MailHeaders.SUBJECT] ?? "your message"}`,
    text: body.reply,
  }))
  .enrich(direct("mail-reply"))
  .to(log());
