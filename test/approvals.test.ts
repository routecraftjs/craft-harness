import { describe, expect, test } from "bun:test";
import {
  ApprovalRequest,
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
