import type { ResumeAcknowledgment } from "@routecraft/routecraft";
import type { Decision } from "./approval.js";

/**
 * The pages an approver is shown, and nothing else.
 *
 * Deliberately plain: no script, no external asset, no styling worth the
 * name. A form post is the one act in this flow a link prefetcher does not
 * perform, and everything beyond that is a byte the approver has to trust.
 *
 * Separate from `approval.ts` because that module decides who may approve
 * what. A diff against the approvals policy should be a change to the policy,
 * not to button wording.
 *
 * ## Why these pages say so little
 *
 * None of them can name the request. Reading a parked exchange by token needs
 * `suspensionIdFor` and the configured store, and the framework exports
 * neither to a route, so a page can only name the verdict. That is also why
 * every page here renders identically whether the token is live, spent or
 * fabricated: the page cannot tell, which means a caller holding a guess
 * learns nothing from it.
 */

/**
 * Headers every page in this module is served with.
 *
 * The URL these pages are fetched at carries the resume token, which is a
 * bearer credential. `no-store` keeps it out of a browser or shared cache,
 * and `no-referrer` keeps it out of the `Referer` of anything the page might
 * later link to.
 */
export const PAGE_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};

/** Escape text for interpolation into HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Wrap body markup in the one document shape every page here uses. */
function page(title: string, body: string[]): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title></head><body>`,
    ...body,
    "</body></html>",
  ].join("\n");
}

/**
 * The confirmation page a decision link opens.
 *
 * The form action is empty, so the POST goes to the document's own URL: the
 * exact path the GET arrived on, token and all. Rebuilding an absolute path
 * would root it at the origin and 404 behind a proxy mounting the harness
 * under a prefix, which `APPROVAL_BASE_URL` is free to name. It also means the
 * token never reaches the markup, and it is what keeps the flow working when
 * a mail gateway rewrites the link it was sent.
 *
 * @param decision The verdict the link carried, already validated
 * @param expiresIn How long the link lives, for the line telling the approver
 *   the page will not wait forever
 */
export function confirmPage(decision: Decision, expiresIn: string): string {
  return page("Confirm your decision", [
    `<h1>Confirm: ${escapeHtml(decision)}</h1>`,
    "<p>Your answer is not recorded until you confirm. Nothing has happened yet.</p>",
    `<p>This link expires ${escapeHtml(expiresIn)} after it was issued. After that you will need a new one.</p>`,
    '<form method="post" action="">',
    `<button type="submit">Confirm ${escapeHtml(decision)}</button>`,
    "</form>",
  ]);
}

/** What a link this harness never issued gets instead of a decision button. */
export function refusalPage(): string {
  return page("Not a valid link", [
    "<h1>This link is not one we issued</h1>",
    "<p>Nothing has been recorded. Open the link from the message you were sent, or ask for a new one.</p>",
  ]);
}

/**
 * What an approver sees once their answer is recorded.
 *
 * The acknowledgment carries the suspension id, the internal route id and the
 * server's own file paths. This mount demands no credential, so it is reduced
 * to one sentence and the detail stays in the logs.
 *
 * @param ack What `.resume()` answered with
 */
export function outcomePage(ack: ResumeAcknowledgment): string {
  return page("Approval", [
    `<p>${escapeHtml(
      ack.status === "duplicate"
        ? "This request was already answered. Nothing changed."
        : "Recorded. You can close this page.",
    )}</p>`,
  ]);
}

/**
 * What an approver sees when the answer could not land.
 *
 * Expired, never minted, already settled and refused all render the same
 * sentence. The cause is the record's lifecycle, and a page on a mount that
 * demands no credential is the wrong place to disclose it.
 */
export function failurePage(): string {
  return page("Approval", [
    "<h1>This answer was not recorded</h1>",
    "<p>The link may have expired or already been used. Nothing has changed. Ask for a new link.</p>",
  ]);
}
