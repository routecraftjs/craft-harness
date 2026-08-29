import { afterEach, describe, expect, test } from "bun:test";
import { craft, direct, noop } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import heartbeat from "../capabilities/scheduling/heartbeat/route.js";
import mailInbox from "../capabilities/mail/mail-inbox/route.js";
import mailReply from "../capabilities/mail/mail-reply/route.js";
import { mailEnabled } from "../env.js";

/**
 * What a fresh scaffold has switched off, and how it says so.
 *
 * Dormancy used to be absence: the module exported no routes and there was
 * nothing to find. That was worse than it looked, because a route nobody
 * wrote is also absent, and only one of those is a configuration someone can
 * fix. A disabled route is registered, off, and carries the reason.
 *
 * These tests hold the harness to that, because "it boots with no secrets"
 * is the template's central promise and a route that quietly starts anyway
 * is how it would stop being true.
 */
describe("dormant capabilities", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.stop();
    t = undefined;
  });

  /**
   * @case The reason names exactly the variables that are missing
   * @preconditions Neither mail variable set, as in a fresh scaffold
   * @expectedResult A string naming both, so an operator reading /ops is told
   *   what to set rather than a sentence someone wrote once and stopped
   *   maintaining
   */
  test("mail says which variables are missing", () => {
    expect(mailEnabled()).toBe("MAIL_ADDRESS, MAIL_APP_PASSWORD unset");
  });

  /**
   * @case The mail routes are registered and off, not absent
   * @preconditions A context holding both mail capabilities and one enabled route
   * @expectedResult Both report disabled with their reason, and neither is in
   *   the capability surface, so no IMAP or SMTP client is constructed and
   *   the agent is never offered them
   */
  test("mail routes register disabled with a reason", async () => {
    t = await testContext()
      .routes([
        mailInbox,
        mailReply,
        craft()
          .id("reachable")
          .description("A route that runs")
          .from(direct())
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    for (const id of ["mail-inbox", "mail-reply"]) {
      expect(t.ctx.isRouteEnabled(id)).toBe(false);
      expect(t.ctx.disabledRoutes().get(id)).toBe(
        "MAIL_ADDRESS, MAIL_APP_PASSWORD unset",
      );
    }
    expect(t.ctx.capabilities().map((c) => c.endpoint)).toEqual(["reachable"]);
  });

  /**
   * @case The heartbeat is off unless it is asked for
   * @preconditions HEARTBEAT_ENABLED unset
   * @expectedResult Disabled with the variable named, so nothing wakes the
   *   agent on a timer and nothing bills for a model call an hour
   */
  test("the heartbeat registers disabled by default", async () => {
    t = await testContext().routes([heartbeat]).build();
    await t.startAndWaitReady();

    expect(t.ctx.isRouteEnabled("heartbeat")).toBe(false);
    expect(t.ctx.disabledRoutes().get("heartbeat")).toBe(
      "HEARTBEAT_ENABLED is not true",
    );
  });
});
