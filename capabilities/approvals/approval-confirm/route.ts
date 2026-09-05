import { craft, http } from "@routecraft/routecraft";
import type { Exchange } from "@routecraft/routecraft";
import {
  PAGE_HEADERS,
  confirmPage,
  refusalPage,
} from "../../../shared/approval-pages.js";
import {
  APPROVAL_TTL,
  isDecision,
  type Decision,
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
 * The page a decision link opens. It resolves nothing.
 *
 * Mail and chat pipelines fetch every link they find before a human sees it,
 * so an endpoint that decided on retrieval was decided by a scanner. This
 * route renders a form; the token is spent only by the POST-only
 * `approval-callback`. The README carries the full reasoning.
 *
 * A segment this harness did not mint is refused rather than coerced. Folding
 * an unrecognised verdict to `deny` would render a working deny button for a
 * link the system never issued, and a mangled URL would record a denial
 * nobody made. Fail-closed here means refusing, not silently choosing.
 *
 * The page names the verdict but not the request: reading a parked exchange
 * by token needs framework internals a route cannot reach, so an approver
 * arriving cold still has to recognise the request from the mail that carried
 * the link.
 */
export default craft()
  .id("approval-confirm")
  .description("Confirm a decision before it is recorded.")
  .throttle({
    rate: 60,
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
      method: "GET",
      mount: "approvals",
    }),
  )
  // A filter would drop the exchange and answer 204, which reads as a blank
  // page rather than a refusal. An approver following a mangled link should
  // be told the link is not one this harness issued.
  .header("routecraft.http.response.status", (exchange) =>
    linkOf(exchange) === undefined ? 400 : 200,
  )
  .header("routecraft.http.response.contentType", "text/html; charset=utf-8")
  .header("routecraft.http.response.headers", PAGE_HEADERS)
  .transform((_body, exchange) => {
    const link = linkOf(exchange);
    return link === undefined
      ? refusalPage()
      : confirmPage(link.decision, APPROVAL_TTL.human);
  });
