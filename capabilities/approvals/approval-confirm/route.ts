import { craft, http } from "@routecraft/routecraft";
import { confirmPage } from "../../../shared/approval.js";

/**
 * The page an approver's link opens. It resolves nothing.
 *
 * Retrieving a URL must not decide anything, and here that is not a
 * principle but a working failure: the links go out by mail and land in the
 * agent's reply, and both are read by machines before a human sees them.
 * Safe Links, Proofpoint, the Gmail proxy, antivirus scanners and chat
 * unfurlers all issue a GET on every link they find. Whichever reached the
 * approve URL first would spend the single-use token, and since both links
 * travel in the same message, which verdict a scanner picked would be
 * arbitrary. The transcript would then record a human approver who never
 * clicked.
 *
 * So this route renders the question and a form. The token is spent only by
 * `approval-callback`, which is POST-only, and a form submission is the one
 * act in this flow no prefetcher performs.
 *
 * The page carries the decision the link named and posts that same decision
 * back, so the approver confirms what they were sent rather than choosing
 * again on a page they did not ask for.
 */
export default craft()
  .id("approval-confirm")
  .description("Show an approver what they are about to decide.")
  .throttle({ rate: 60, per: "minute", mode: "reject" })
  .from(
    http({
      path: "/approvals/:token/:decision",
      method: "GET",
      mount: "approvals",
    }),
  )
  .header("routecraft.http.response.contentType", "text/html; charset=utf-8")
  .transform((_body, exchange) => {
    const params = exchange.headers["routecraft.http.params"];
    return confirmPage(
      String(params?.["token"] ?? ""),
      String(params?.["decision"] ?? ""),
    );
  });
