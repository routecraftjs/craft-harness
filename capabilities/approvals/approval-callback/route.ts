import {
  craft,
  http,
  otherwise,
  when,
  type Exchange,
} from "@routecraft/routecraft";
import { OPERATOR_SUBJECT } from "../../../craft.config.js";
import {
  type Decision,
  isDecision,
  isKnownApprover,
  outcomePage,
  refusalPage,
} from "../../../shared/approval.js";

/**
 * The door that actually spends the token, reached only by a form post.
 *
 * POST because `approval-confirm` serves the GET a mailed link opens; the
 * README carries why retrieval must not decide.
 *
 * One endpoint for both answers: the decision is a path segment, so the two
 * links a request produces differ only in that segment and both spend the
 * same single-use token. `.resume()` addresses the parked exchange by token
 * rather than by route, so nothing here needs to know what was parked.
 *
 * ## Who is answering
 *
 * `authorize` runs before the store's claim and before the record's
 * lifecycle is disclosed, so a refusal costs the rightful approver nothing
 * and tells a refused caller nothing. It admits only a subject `APPROVERS`
 * names. Which scope THIS request needs is checked in `approval-park`'s
 * continuation, where the request body is readable; the hook deliberately
 * cannot see the body.
 *
 * ## Raising the floor
 *
 * With no validator on this mount, the principal is whatever the mount
 * verified, which is nobody, so the token is the credential and the mailed
 * link is the sender check. Put `jwks()` (or `jwt()`) on the `approvals`
 * mount in `craft.config.ts` and the same hook starts reading a verified
 * subject instead: every approval in the harness moves from "holder of a
 * link" to "this person", and no route changes.
 */
/**
 * The token and verdict a request's path carries, or `undefined` when the
 * path is not one this harness minted.
 */
function linkOf(
  exchange: Exchange,
): { token: string; decision: Decision } | undefined {
  const params = exchange.headers["routecraft.http.params"];
  const token = String(params?.["token"] ?? "");
  const decision = String(params?.["decision"] ?? "");
  if (token === "" || !isDecision(decision)) return undefined;
  return { token, decision };
}

export default craft()
  .id("approval-callback")
  .description("Resolve an approval from the link a human was sent.")
  // Public in the sense that it demands no credential of its own. A token
  // is single-use and short-lived, but it is guessable-shaped enough to be
  // worth pacing, and this door is reachable from wherever the mail went.
  .throttle({ rate: 30, per: "minute", mode: "reject" })
  .from(
    http({
      path: "/approvals/:token/:decision",
      method: "POST",
      mount: "approvals",
    }),
  )
  // The same rule the confirmation page applies, on the door that records.
  // Hardening only the page left `decision === "approve"` here treating every
  // other segment as a denial, so a rewritten or truncated URL reaching this
  // route recorded a verdict nobody chose and burned the single-use token,
  // which is the failure the split exists to prevent. A branch rather than a
  // filter, because a dropped exchange answers 204 and a refusal should say so.
  .header("routecraft.http.response.contentType", "text/html; charset=utf-8")
  .choice(
    when(
      (exchange) => linkOf(exchange) !== undefined,
      (branch) =>
        branch
          .resume(
            (exchange) => {
              const link = linkOf(exchange);
              if (link === undefined) {
                throw new Error("unreachable: guarded by the branch");
              }
              return {
                token: link.token,
                result: { approved: link.decision === "approve" },
              };
            },
            {
              // At the floor there is no validator on this mount, so nobody
              // is verified and the credential is the token itself plus the
              // fact that the link was mailed only to the address the request
              // named. Put a validator on the mount and this same line starts
              // demanding that the verified subject be a configured approver.
              authorize: ({ principal }) =>
                principal === undefined ||
                principal.subject === OPERATOR_SUBJECT ||
                isKnownApprover(principal.subject),
            },
          )
          // The raw acknowledgment names the suspension, the internal route
          // and the server's own file paths, on a mount that carries no
          // credential, and an approver's browser now renders it.
          .transform((ack) => outcomePage(ack)),
    ),
    otherwise((branch) =>
      branch
        .header("routecraft.http.response.status", 400)
        .transform(() => refusalPage()),
    ),
  );
