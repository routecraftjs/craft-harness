import {
  type Path,
  type Suspended,
  craft,
  direct,
  isSuspended,
  mail,
  only,
} from "@routecraft/routecraft";
import { env, mailConfigured } from "../../../env.js";
import {
  ApprovalRequest,
  decisionLinks,
  isKnownApprover,
} from "../../../shared/approval.js";

/**
 * Ask a human for permission, and hand the agent the link to show them.
 *
 * One flow, two deliveries. `approval-park` does the parking and answers
 * with the framework's suspension acknowledgment; this route turns that
 * acknowledgment's token into the two links and returns them, so the link
 * lands in the tool result and the agent can put it straight into its
 * reply. When a mailbox is configured, the same links are also mailed to
 * the approver, which is what makes the mail delivery a sender check rather
 * than a second channel: it can only reach an address `APPROVERS` names.
 *
 * The split exists because a route that parks answers its caller with the
 * acknowledgment instead of its own output. Keeping the park in its own
 * capability is what lets this one return something a model can read.
 */

/** What the caller gets back: the same links, both live, both single-use. */
interface ApprovalLinks {
  approveLink: string;
  denyLink: string;
  suspensionId: string;
  expiresAt: string;
  approver: string;
  question: string;
  scope: string;
}

/**
 * The mail delivery, as a multicast path.
 *
 * A path rather than a step in the main flow, so a mailbox that is down
 * cannot stop the links reaching the caller. It is added to the route only
 * when a mailbox is configured, which is what keeps `mail()` unconstructed
 * on a scaffold that has none.
 */
const mailTheLinks: Path<ApprovalLinks, unknown> = (path) =>
  path
    .transform((body) => ({
      to: body.approver,
      from: env.MAIL_ADDRESS,
      subject: `Approval needed: ${body.question.slice(0, 60)}`,
      text: [
        body.question,
        "",
        `Permission: ${body.scope}`,
        `Approve: ${body.approveLink}`,
        `Deny:    ${body.denyLink}`,
        body.expiresAt === ""
          ? ""
          : `The links stop working at ${body.expiresAt}.`,
      ].join("\n"),
    }))
    .to(mail());

export default craft()
  .id("request-approval")
  .description(
    "Ask a named human to approve something, and get back a link to send them.",
  )
  .input({
    body: ApprovalRequest.refine((body) => isKnownApprover(body.approver), {
      message:
        "That approver is not configured. APPROVERS decides who can be asked.",
    }),
  })
  .from<ApprovalRequest>(direct())
  .enrich(
    direct<ApprovalRequest, Suspended>("approval-park"),
    only((parked: Suspended) => parked, "parked"),
  )
  // A park that did not happen means the request was answered synchronously,
  // which this flow has no way to have produced. Refusing beats handing the
  // agent a link built from a token that is not there.
  .filter((exchange) =>
    isSuspended(exchange.body.parked)
      ? true
      : { reason: "approval-park did not park the request" },
  )
  .transform((body): ApprovalLinks => ({
    ...decisionLinks(body.parked.token),
    suspensionId: body.parked.suspensionId,
    expiresAt: body.parked.expiresAt ?? "",
    approver: body.approver,
    question: body.question,
    scope: body.scope,
  }))
  .multicast(...(mailConfigured ? [mailTheLinks] : []));
