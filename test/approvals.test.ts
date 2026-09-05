import { describe, expect, test } from "bun:test";
import { bootServer } from "@routecraft/testing";
import approvalCallback from "../capabilities/approvals/approval-callback/route.js";
import approvalConfirm from "../capabilities/approvals/approval-confirm/route.js";
import approvalPark from "../capabilities/approvals/approval-park/route.js";
import { confirmPage, failurePage } from "../shared/approval-pages.js";
import {
  APPROVAL_TTL,
  ApprovalRequest,
  DECISIONS,
  decisionLinks,
  isKnownApprover,
  mayApprove,
  resultFor,
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

/** The split that keeps a link scanner from approving. See the README for why. */
describe("approval link handling", () => {
  /**
   * @case Retrieving a decision link does not spend the token
   * @preconditions A real parked approval, its link fetched with GET and then
   *   confirmed with POST against a booted server
   * @expectedResult The GET answers HTML carrying a form and leaves the token
   *   unspent, and the POST that follows still resolves it. Both halves are
   *   asserted together because a GET that refused everything would pass the
   *   first half while breaking the flow.
   */
  test("a GET renders and does not resolve, a POST resolves", async () => {
    const booted = await bootServer((b) =>
      b
        .with({
          suspension: {},
          // The routes mount on `approvals`, and declaring mounts replaces
          // whatever bootServer would have supplied, so the server it binds
          // has to be declared here too. Port 0 lets the OS choose it.
          servers: { default: { port: 0 } },
          http: { mounts: { approvals: { path: "/", auth: false } } },
        })
        .routes([approvalPark, approvalConfirm, approvalCallback]),
    );
    try {
      const parked = await booted.ctx.client.sendDirect<
        unknown,
        { token?: string }
      >("approval-park", {
        question: "Ship it",
        scope: "publish",
        approver: "ops@example.com",
        session: "demo",
      });
      const token = String(parked.token ?? "");
      expect(token).not.toBe("");

      const url = `http://127.0.0.1:${booted.port}/approvals/${encodeURIComponent(token)}/approve`;

      const page = await fetch(url);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toContain('method="post"');

      // The token survived retrieval, which is the property under test.
      const posted = await fetch(url, { method: "POST" });
      expect(posted.status).toBeLessThan(400);
    } finally {
      await booted.ctx.stop();
    }
  });

  /**
   * @case The door that records refuses an unminted segment too
   * @preconditions A real parked approval, its token posted with a mangled
   *   verdict segment, then with the genuine one
   * @expectedResult The mangled POST is refused and leaves the token unspent,
   *   so the genuine approve that follows still resolves. Hardening only the
   *   page left this coercing every non-approve segment into a denial, which
   *   recorded a verdict nobody chose and burned the single-use token.
   */
  test("a mangled verdict does not record a denial or spend the token", async () => {
    const booted = await bootServer((b) =>
      b
        .with({
          suspension: {},
          servers: { default: { port: 0 } },
          http: { mounts: { approvals: { path: "/", auth: false } } },
        })
        .routes([approvalPark, approvalConfirm, approvalCallback]),
    );
    try {
      const parked = await booted.ctx.client.sendDirect<
        unknown,
        { token?: string }
      >("approval-park", {
        question: "Ship it",
        scope: "publish",
        approver: "ops@example.com",
        session: "demo",
      });
      const token = encodeURIComponent(String(parked.token ?? ""));
      const base = `http://127.0.0.1:${booted.port}/approvals/${token}`;

      const mangled = await fetch(`${base}/approv`, { method: "POST" });
      expect(mangled.status).toBe(400);

      const genuine = await fetch(`${base}/approve`, { method: "POST" });
      expect(genuine.status).toBeLessThan(400);
      expect(await genuine.text()).toContain("Recorded");
    } finally {
      await booted.ctx.stop();
    }
  });

  /**
   * @case A segment this harness never minted is refused, not coerced
   * @preconditions A link whose decision segment is neither approve nor deny
   * @expectedResult Refused rather than rendered as a deny page. Folding it to
   *   deny would show a working button for a link the system never issued, so
   *   a mangled URL would record a denial nobody made.
   */
  test("refuses a decision segment it did not issue", async () => {
    const booted = await bootServer((b) =>
      b
        .with({
          suspension: {},
          servers: { default: { port: 0 } },
          http: { mounts: { approvals: { path: "/", auth: false } } },
        })
        .routes([approvalConfirm]),
    );
    try {
      const res = await fetch(
        `http://127.0.0.1:${booted.port}/approvals/tok/approve-please`,
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("not one we issued");
    } finally {
      await booted.ctx.stop();
    }
  });

  /**
   * @case The page posts to its own URL rather than a rebuilt one
   * @preconditions confirmPage as shipped
   * @expectedResult An empty action, which resolves against the document URL,
   *   so the POST lands on the exact path the GET arrived on. A rebuilt
   *   absolute path would be rooted at the origin and 404 behind a proxy that
   *   mounts the harness under a prefix, which APPROVAL_BASE_URL may name.
   */
  test("posts to its own URL rather than a rebuilt one", () => {
    expect(confirmPage("approve", APPROVAL_TTL.human)).toContain('action=""');
    expect(confirmPage("approve", APPROVAL_TTL.human)).not.toContain(
      "/approvals/",
    );
    expect(confirmPage("deny", APPROVAL_TTL.human)).toContain("Confirm: deny");
  });

  /**
   * @case No caller-supplied text reaches the rendered page
   * @preconditions confirmPage given a validated decision and nothing else
   * @expectedResult No script tag and an empty action. The token never enters
   *   the markup and the decision is narrowed to two literals before it gets
   *   here, so there is no injection surface left rather than an escaped one.
   */
  test("renders no caller-supplied text at all", () => {
    const page = confirmPage("approve", APPROVAL_TTL.human);
    expect(page).not.toContain("<script");
    expect(/action="([^"]*)"/.exec(page)?.[1]).toBe("");
  });

  /**
   * @case Every minted verdict has an explicit meaning
   * @preconditions The decision vocabulary as declared
   * @expectedResult Each value maps to a verdict deliberately. A third value
   *   added to DECISIONS without an arm in resultFor fails the typecheck
   *   rather than being recorded as a refusal against a token that cannot be
   *   answered twice, and this pins that every declared value is covered.
   */
  test("map every minted verdict deliberately", () => {
    expect(resultFor("approve")).toEqual({ approved: true });
    expect(resultFor("deny")).toEqual({ approved: false });
    for (const decision of DECISIONS) {
      expect(typeof resultFor(decision).approved).toBe("boolean");
    }
  });

  /**
   * @case The failure page tells the approver nothing was recorded
   * @preconditions failurePage as shipped
   * @expectedResult It says nothing changed and to ask for a new link, and it
   *   names no cause: expired, never minted and already settled all render the
   *   same words, because this mount demands no credential.
   */
  test("say nothing was recorded, and why not", () => {
    const page = failurePage();
    expect(page).toContain("Nothing has changed");
    expect(page).toContain("Ask for a new link");
    for (const code of ["RC5041", "RC5046", "RC5047", "RC5056"]) {
      expect(page).not.toContain(code);
    }
  });

  /**
   * @case The confirmation page warns that the link will not wait
   * @preconditions The TTL approval-park suspends with
   * @expectedResult The page names the same window, so an approver who has
   *   left the tab open knows the answer can still be refused
   */
  test("warn that the link expires", () => {
    expect(confirmPage("approve", APPROVAL_TTL.human)).toContain(
      APPROVAL_TTL.human,
    );
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

  /**
   * @case A token that cannot be resumed answers a page, not a server error
   * @preconditions A booted approvals mount and a syntactically valid token
   *   that was never minted, which is what an expired link becomes once the
   *   sweeper has retired the record
   * @expectedResult HTML saying nothing was recorded. Without an error arm the
   *   resume throws, the dispatcher serves its JSON 500, and the approver who
   *   opened the mail late has no way to learn they need a new link.
   */
  test("answer an unusable token with a page rather than a 500", async () => {
    const booted = await bootServer((b) =>
      b
        .with({
          suspension: {},
          servers: { default: { port: 0 } },
          http: { mounts: { approvals: { path: "/", auth: false } } },
        })
        .routes([approvalPark, approvalConfirm, approvalCallback]),
    );
    try {
      const url = `http://127.0.0.1:${booted.port}/approvals/never-minted/approve`;

      const page = await fetch(url);
      expect(page.status).toBe(200);
      expect(page.headers.get("cache-control")).toBe("no-store");

      const posted = await fetch(url, { method: "POST" });
      expect(posted.status).toBe(400);
      expect(posted.headers.get("content-type")).toContain("text/html");
      const body = await posted.text();
      expect(body).toContain("Ask for a new link");
      expect(body).not.toContain("internal server error");
    } finally {
      await booted.ctx.stop();
    }
  });
});
