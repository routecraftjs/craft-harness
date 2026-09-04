import { describe, expect, test } from "bun:test";
import {
  ApprovalRequest,
  confirmPage,
  decisionLinks,
  isKnownApprover,
  mayApprove,
} from "../shared/approval.js";

/**
 * Who can approve what, and what a link is.
 *
 * `test/setup.ts` leaves `APPROVERS` unset, which is a fresh scaffold: nobody
 * is configured, so nothing can be approved. That is the state these tests
 * hold the harness to, because the alternative default (anyone may approve)
 * is the one that cannot be noticed.
 */
describe("approvals", () => {
  /**
   * @case Nobody can approve anything until someone is named
   * @preconditions APPROVERS unset, as in a fresh scaffold
   * @expectedResult Every subject is unknown and holds no scope
   */
  test("refuse every approver while APPROVERS is unset", () => {
    expect(isKnownApprover("ops@example.com")).toBe(false);
    expect(mayApprove("ops@example.com", "spend")).toBe(false);
    expect(mayApprove("", "spend")).toBe(false);
  });

  /**
   * @case A request naming an unconfigured approver is refused at the input
   * @preconditions APPROVERS unset
   * @expectedResult Validation fails, so no exchange is parked for an
   *   approver who could never answer it
   */
  test("refuse a request naming an unconfigured approver", () => {
    expect(
      ApprovalRequest.refine((body) =>
        isKnownApprover(body.approver),
      ).safeParse({
        question: "spend money",
        scope: "spend",
        approver: "ops@example.com",
      }).success,
    ).toBe(false);
  });

  /**
   * @case Both links address the same parked exchange
   * @preconditions One resume token
   * @expectedResult Two URLs differing only in the decision segment, both
   *   carrying the same single-use token, so answering through either spends
   *   it
   */
  test("mint one token as two links", () => {
    const { approveLink, denyLink } = decisionLinks("tok-123");
    expect(approveLink).toEndWith("/approvals/tok-123/approve");
    expect(denyLink).toEndWith("/approvals/tok-123/deny");
    expect(approveLink.replace("/approve", "")).toBe(
      denyLink.replace("/deny", ""),
    );
  });

  /**
   * @case A token is escaped into the path
   * @preconditions A token containing characters that are meaningful in a URL
   * @expectedResult The link carries the escaped form, so a token cannot
   *   introduce a path segment of its own
   */
  test("escape a token into the link", () => {
    const { approveLink } = decisionLinks("a/b?c=d");
    expect(approveLink).toContain("a%2Fb%3Fc%3Dd");
  });
});

/**
 * The split that keeps a link scanner from approving.
 *
 * The hazard is not hypothetical and not about this code being wrong in
 * isolation: mail and chat pipelines fetch every link they see, so any
 * endpoint that resolves an approval on retrieval is resolved by a machine
 * before the human reads the message. These tests hold the two halves apart.
 */
describe("approval link handling", () => {
  /**
   * @case The route that spends the token refuses to be retrieved
   * @preconditions The callback route as shipped
   * @expectedResult Its source is POST, so a GET from a scanner reaches the
   *   confirmation page instead and decides nothing
   */
  test("the token is spent by POST, never by GET", async () => {
    const route = (
      await import("../capabilities/approvals/approval-callback/route.js")
    ).default;
    const json = JSON.stringify(route);
    expect(json).toContain('"POST"');
    expect(json).not.toContain('"GET"');
  });

  /**
   * @case The page a mailed link opens resolves nothing
   * @preconditions The confirm route as shipped
   * @expectedResult It carries no resume step, so retrieving it cannot spend
   *   a token however many times a scanner follows the link
   */
  test("the confirmation page carries no resume", async () => {
    const route = (
      await import("../capabilities/approvals/approval-confirm/route.js")
    ).default;
    expect(JSON.stringify(route)).not.toContain("resume");
  });

  /**
   * @case The page posts back the decision the link named
   * @preconditions A link naming approve, and one naming deny
   * @expectedResult Each page posts its own verdict, so confirming sends
   *   back what was sent out rather than a fresh choice
   */
  test("each page posts back the verdict its link carried", () => {
    expect(confirmPage("tok", "approve")).toContain(
      'action="/approvals/tok/approve"',
    );
    expect(confirmPage("tok", "deny")).toContain(
      'action="/approvals/tok/deny"',
    );
  });

  /**
   * @case An unrecognised decision segment is not echoed as itself
   * @preconditions A link whose decision segment is neither approve nor deny
   * @expectedResult Treated as deny, so a malformed or tampered link cannot
   *   produce a page that posts an approval
   */
  test("an unknown decision falls to deny", () => {
    const page = confirmPage("tok", "approve-please");
    expect(page).toContain('action="/approvals/tok/deny"');
    expect(page).not.toContain("approve-please");
  });

  /**
   * @case A token carrying HTML metacharacters cannot break out of the markup
   * @preconditions A token holding a quote, angle brackets and a script tag
   * @expectedResult Neither the tag nor a bare quote survives into the page.
   *   Percent-encoding neutralises it before the HTML escaper sees it, so the
   *   escaper is defence in depth rather than the only guard; this asserts the
   *   property both provide rather than either mechanism.
   */
  test("cannot be broken out of by a hostile token", () => {
    const page = confirmPage('"><script>alert(1)</script>', "approve");
    expect(page).not.toContain("<script");
    const action = /action="([^"]*)"/.exec(page)?.[1] ?? "";
    expect(action).not.toContain("<");
    expect(action).not.toContain(">");
    expect(action).toContain("%3Cscript%3E");
  });

  /**
   * @case The mailed links point at the page, not at the resolver
   * @preconditions decisionLinks as shipped
   * @expectedResult Both links are the GET path the confirm route serves, so
   *   nothing a scanner follows reaches the POST that spends the token
   */
  test("mailed links address the confirmation page", () => {
    const { approveLink, denyLink } = decisionLinks("tok");
    expect(approveLink).toContain("/approvals/tok/approve");
    expect(denyLink).toContain("/approvals/tok/deny");
  });
});
