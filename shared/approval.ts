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

/** The two verdicts a decision link can carry. */
export type Decision = "approve" | "deny";

/** Whether a URL segment is a verdict this harness minted. */
export function isDecision(value: string): value is Decision {
  return value === "approve" || value === "deny";
}

/**
 * The confirmation page a decision link opens.
 *
 * Deliberately plain: no script, no external asset, no styling worth the
 * name. A form post is the one act in this flow a link prefetcher does not
 * perform, and everything beyond that is a byte the approver has to trust.
 *
 * The form action is empty, so the POST goes to the document's own URL: the
 * exact path the GET arrived on, token and all. Rebuilding an absolute path
 * would root it at the origin and 404 behind a proxy mounting the harness
 * under a prefix, which `APPROVAL_BASE_URL` is free to name. It also means the
 * token never reaches the markup.
 *
 * It cannot show the request itself. Reading a parked exchange by token needs
 * `suspensionIdFor` and the configured store, and the framework exports
 * neither to a route, so the page names the verdict and not the question. See
 * the README on what an approver therefore has to carry from the mail.
 *
 * @param decision The verdict the link carried, already validated
 */
export function confirmPage(decision: Decision): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    "<title>Confirm your decision</title></head><body>",
    `<h1>Confirm: ${escapeHtml(decision)}</h1>`,
    "<p>Your answer is not recorded until you confirm. Nothing has happened yet.</p>",
    '<form method="post" action="">',
    `<button type="submit">Confirm ${escapeHtml(decision)}</button>`,
    "</form>",
    "</body></html>",
  ].join("\n");
}

/** Escape text for interpolation into HTML. Both page inputs come from a URL. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** What a link this harness never issued gets instead of a decision button. */
export function refusalPage(): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    "<title>Not a valid link</title></head><body>",
    "<h1>This link is not one we issued</h1>",
    "<p>Nothing has been recorded. Open the link from the message you were sent, or ask for a new one.</p>",
    "</body></html>",
  ].join("\n");
}

/**
 * What an approver sees once their answer is recorded.
 *
 * The resume acknowledgment carries the suspension id, the internal route id
 * and the server's own file paths. This mount demands no credential and the
 * approver's browser now lands here from a form, so the acknowledgment is
 * summarised rather than rendered: the detail stays in the logs, where it is
 * useful and not public.
 *
 * @param ack Whatever `.resume()` answered with
 */
export function outcomePage(ack: unknown): string {
  const status =
    typeof ack === "object" && ack !== null && "status" in ack
      ? String((ack as { status: unknown }).status)
      : "";
  const line =
    status === "duplicate"
      ? "This request was already answered. Nothing changed."
      : status === "resumed"
        ? "Recorded. You can close this page."
        : "Your answer could not be recorded. Ask for a new link.";
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    "<title>Approval</title></head><body>",
    `<p>${escapeHtml(line)}</p>`,
    "</body></html>",
  ].join("\n");
}
