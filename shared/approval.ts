import { z } from "zod";
import { env } from "../env.js";
import { SessionId } from "./transcript.js";

/**
 * Approvals: what a human is being asked, and who may answer.
 *
 * One flow with two deliveries. The link is minted once, comes back in the
 * tool result so the agent can put it in its reply, and is mailed to the
 * approver when a mailbox is configured. Both deliveries carry the same
 * single-use token against the same parked exchange, so answering through
 * either one spends it.
 *
 * ## What the magic link is and is not
 *
 * The token proves the deployment minted this link for this request. It does
 * not prove who is holding it. That floor is raised in two ways here.
 *
 * The link is short-lived and single-use, so a leaked one is worth little
 * for long. And when it is mailed, the mail loop is the sender check: it is
 * sent only to an address in {@link approverScopes}, so a request naming an
 * approver who is not configured never produces a delivery.
 *
 * The floor is deliberately replaceable rather than final. `approval-callback`
 * takes whatever principal its mount verified, so putting a validator on
 * that mount (`jwks()`, `jwt()`) upgrades every approval in the harness
 * from "holder of a link" to "this verified person", with no change to the
 * routes.
 */

/** Who may approve what, from `APPROVERS`. */
export const approverScopes: Record<string, string[]> = env.APPROVERS;

/** The verdict a human sends back. */
export const ApprovalDecision = z.object({
  approved: z.boolean().describe("Whether the request is allowed to proceed."),
  comment: z.string().max(2_000).optional().describe("Why, in a sentence."),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

/** What the agent asks a human for. */
export const ApprovalRequest = z.object({
  question: z
    .string()
    .min(1)
    .max(2_000)
    .describe("What you want to do, in one or two sentences."),
  scope: z
    .string()
    .min(1)
    .describe(
      "The permission this needs, e.g. spend or publish. The approver must hold it.",
    ),
  approver: z
    .string()
    .min(1)
    .describe("Who should answer. Must be someone APPROVERS names."),
  session: SessionId.default("scheduled").describe(
    "Conversation the verdict is reported back into.",
  ),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

/** Whether a subject is configured to approve anything at all. */
export function isKnownApprover(subject: string): boolean {
  return Object.hasOwn(approverScopes, subject);
}

/** Whether a subject holds the scope a specific request needs. */
export function mayApprove(subject: string, scope: string): boolean {
  return approverScopes[subject]?.includes(scope) === true;
}

/** The two links a request produces, both against the same parked exchange. */
export function decisionLinks(token: string): {
  approveLink: string;
  denyLink: string;
} {
  const base = env.APPROVAL_BASE_URL.replace(/\/+$/, "");
  const encoded = encodeURIComponent(token);
  return {
    approveLink: `${base}/approvals/${encoded}/approve`,
    denyLink: `${base}/approvals/${encoded}/deny`,
  };
}

/**
 * How long a decision link lives.
 *
 * Two spellings of one window: `duration` is what `.suspend()` parses, `human`
 * is what the confirmation page tells the approver. Short because the link is
 * a bearer credential, and a request nobody answers within half an hour is
 * better re-asked than left live.
 */
export const APPROVAL_TTL = { duration: "30m", human: "30 minutes" } as const;

/** The verdicts a decision link can carry. */
export const DECISIONS = ["approve", "deny"] as const;
export type Decision = (typeof DECISIONS)[number];

/** Whether a URL segment is a verdict this harness minted. */
export function isDecision(value: string): value is Decision {
  return (DECISIONS as readonly string[]).includes(value);
}

/**
 * The verdict a decision segment stands for, in the shape the parked route
 * reads.
 *
 * A switch with no default, so widening {@link DECISIONS} is a compile error
 * here rather than a third verdict silently recorded as a refusal against a
 * token that cannot be answered twice.
 *
 * @param decision The verdict the link carried, already validated
 */
export function resultFor(decision: Decision): ApprovalDecision {
  switch (decision) {
    case "approve":
      return { approved: true };
    case "deny":
      return { approved: false };
  }
}
