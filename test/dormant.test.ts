import { describe, expect, test } from "bun:test";
import heartbeat from "../capabilities/scheduling/heartbeat/route.js";
import mailInbox from "../capabilities/mail/mail-inbox/route.js";
import mailReply from "../capabilities/mail/mail-reply/route.js";
import { mailConfigured } from "../env.js";

/**
 * What a fresh scaffold does NOT construct.
 *
 * Dormancy here is absence, not a runtime flag: a route that exists and
 * refuses is still a route in the registry, in the ops listing, and in the
 * agent's tool surface, all describing something that cannot work. These
 * tests assert the absence, because "it boots with no secrets" is the
 * template's central promise and a stray adapter construction is how it
 * would quietly stop being true.
 */
describe("dormant capabilities", () => {
  /**
   * @case Mail is off without a mailbox
   * @preconditions No MAIL_ADDRESS and no MAIL_APP_PASSWORD, as in a fresh
   *   scaffold
   * @expectedResult Both mail modules export no routes, so no IMAP or SMTP
   *   client is ever constructed
   */
  test("mail exports no routes without a mailbox", () => {
    expect(mailConfigured).toBe(false);
    expect(mailInbox).toEqual([]);
    expect(mailReply).toEqual([]);
  });

  /**
   * @case The heartbeat is off unless it is asked for
   * @preconditions HEARTBEAT_ENABLED unset
   * @expectedResult No routes, so nothing wakes the agent on a timer and
   *   nothing bills for a model call an hour
   */
  test("the heartbeat exports no routes by default", () => {
    expect(heartbeat).toEqual([]);
  });
});
