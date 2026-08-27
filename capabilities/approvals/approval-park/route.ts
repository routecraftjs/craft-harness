import { craft, direct, log } from "@routecraft/routecraft";
import type { ChatInput } from "../../chat/chat/route.js";
import {
  ApprovalDecision,
  ApprovalRequest,
  mayApprove,
} from "../../../shared/approval.js";

/**
 * The parked half of an approval.
 *
 * This route exists to hold an exchange still while a human thinks. It
 * parks at `.suspend()`, and everything after that line runs when someone
 * answers, possibly days later and certainly in a different process.
 *
 * ## Why the scope check is here and not in the resume hook
 *
 * `.suspend({ meta })` takes a value, not a function of the exchange, so
 * `meta` describes the SITE rather than the request: it can say "only a
 * configured approver may answer this", which is what `approval-callback`'s
 * hook enforces before the token is spent. It cannot say which scope THIS
 * request needs, because that arrived in the body and the hook deliberately
 * cannot see the body.
 *
 * So the check is in two stages. The hook is the coarse one and runs first,
 * before the single-use claim: an unknown approver is refused having spent
 * nothing. The scope is the fine one and runs here, where the request is
 * readable. An approver who is configured but lacks the scope therefore
 * spends the link and gets a denial rather than a refusal, which is the
 * right way round: they were entitled to answer, they were not entitled to
 * say yes to this.
 */
export default craft()
  .id("approval-park")
  .description("Hold a request until a human approves or denies it.")
  .input({ body: ApprovalRequest })
  .from<ApprovalRequest>(direct())
  .suspend({
    schema: ApprovalDecision,
    // Short because the link is a bearer credential. A request nobody
    // answers within half an hour is better re-asked than left live.
    ttl: "30m",
    // Site policy, not request policy. `approval-callback` reads it to
    // decide whether to let the resume through at all.
    meta: { requires: "configured-approver" },
  })
  .transform((request, exchange) => {
    const decision = exchange.suspension.result;
    const resumer = exchange.suspension.resumedBy?.subject;
    // With no validator on the approval door nobody is verified, so the
    // approver the request named is who this is credited to: the link went
    // to that address and nowhere else. With a validator, the verified
    // subject is who answered, and it has to be the person who was asked.
    const decidedBy = resumer ?? request.approver;
    const identityOk = resumer === undefined || resumer === request.approver;
    const entitled = identityOk && mayApprove(decidedBy, request.scope);
    return {
      ...request,
      approved: decision.approved && entitled,
      decidedBy,
      reason: !identityOk
        ? `${decidedBy} answered a request addressed to ${request.approver}.`
        : !entitled
          ? `${decidedBy} does not hold "${request.scope}".`
          : (decision.comment ?? ""),
    };
  })
  // The verdict goes back into the conversation that asked for it, so the
  // agent learns the answer the same way it learns everything else: as a
  // message in the transcript, days later, in whichever process is running.
  .transform((verdict): ChatInput => ({
    session: verdict.session,
    message: `Approval ${verdict.approved ? "granted" : "refused"} by ${verdict.decidedBy || "nobody"} for: ${verdict.question}${verdict.reason === "" ? "" : ` (${verdict.reason})`}`,
  }))
  .enrich(direct("chat"))
  .to(log());
