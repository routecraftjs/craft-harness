import {
  craft,
  http,
  otherwise,
  when,
  type Exchange,
} from "@routecraft/routecraft";
import { OPERATOR_SUBJECT } from "../../../craft.config.js";
import {
  PAGE_HEADERS,
  failurePage,
  outcomePage,
  refusalPage,
} from "../../../shared/approval-pages.js";
import {
  type Decision,
  isDecision,
  isKnownApprover,
  resultFor,
} from "../../../shared/approval.js";

/** The token a request's path carries, whether or not the rest of it parses. */
function tokenOf(exchange: Exchange): string {
  return String(
    exchange.headers["routecraft.http.params"]?.["token"] ?? "anonymous",
  );
}

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
 * ## Why a branch and not a filter
 *
 * A segment this harness never minted is refused with a 400 rather than
 * dropped. A dropped exchange answers 204, which renders as a blank page,
 * and a refusal should say so. The guard sits here as well as on the
 * confirmation page because this is the door that records.
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
export default craft()
  .id("approval-callback")
  .description(
    "Record an approval verdict submitted from the confirmation form.",
  )
  // Route scope, so it covers the resume below rather than the next step
  // alone, and its return value becomes the response body. A resume that
  // cannot land is the TTL doing its job, not a fault: expired, never minted,
  // already settled and refused all render one sentence, because the cause is
  // the record's lifecycle and this mount demands no credential.
  .error(() => failurePage())
  // Public in the sense that it demands no credential of its own. A token
  // is single-use and short-lived, but it is guessable-shaped enough to be
  // worth pacing, and this door is reachable from wherever the mail went.
  .throttle({
    rate: 30,
    per: "minute",
    mode: "reject",
    // Per link, not per route. One bucket for the whole route lets any
    // anonymous caller spend the minute on tokens nobody minted and reject
    // the approver who actually holds one.
    key: tokenOf,
  })
  .from(
    http({
      path: "/approvals/:token/:decision",
      method: "POST",
      mount: "approvals",
    }),
  )
  .header("routecraft.http.response.contentType", "text/html; charset=utf-8")
  .header("routecraft.http.response.headers", PAGE_HEADERS)
  // Refusal is the default so the error handler above does not have to set it.
  // A handler cannot: the exchange's headers are not writable from there, and
  // a handler that throws takes the default error path, which is the 500 this
  // whole arm exists to avoid. Only the branch that records raises it to 200.
  .header("routecraft.http.response.status", 400)
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
              return { token: link.token, result: resultFor(link.decision) };
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
          // The raw acknowledgment carries the suspension id, the internal
          // route id and absolute server paths, and this mount demands no
          // credential, so only the summary may reach the page.
          .header("routecraft.http.response.status", 200)
          .transform((ack) => outcomePage(ack)),
    ),
    otherwise((branch) =>
      branch
        .header("routecraft.http.response.status", 400)
        .transform(() => refusalPage()),
    ),
  );
