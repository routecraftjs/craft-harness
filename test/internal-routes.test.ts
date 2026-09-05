import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import approvalPark from "../capabilities/approvals/approval-park/route.js";
import requestApproval from "../capabilities/approvals/request-approval/route.js";
import schedulesOwner from "../capabilities/scheduling/schedules-owner/route.js";
import scheduleTask from "../capabilities/scheduling/schedule-task/route.js";
import transcriptOwner from "../capabilities/chat/transcript-owner/route.js";

/**
 * The one route in this harness that exists to be called by another route.
 *
 * `approval-park` carries no `.authorize()` and no useful answer for an
 * outside caller: it exists so `request-approval` can hand back a link, and
 * a direct caller would get the framework's suspension acknowledgment. That
 * is what `direct({ internal: true })` declares, and this is the test that
 * the declaration is doing something rather than decorating the file.
 */
describe("internal routes", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.stop();
    t = undefined;
  });

  /**
   * @case An internal subroutine is absent from the dispatch surface
   * @preconditions A context holding the internal park route and its boundary
   * @expectedResult Only the boundary capability is discoverable, so the ops
   *   dispatch door and the agent tool surface both refuse the subroutine by
   *   construction rather than by policy
   */
  test("keep approval-park off the capability surface", async () => {
    t = await testContext()
      // A route that can park needs somewhere to park; the defaults are
      // in-memory under testContext, which is what a test wants.
      .with({ suspension: {} })
      .routes([approvalPark, requestApproval])
      .build();
    await t.startAndWaitReady();

    const endpoints = t.ctx.capabilities().map((c) => c.endpoint);
    expect(endpoints).toContain("request-approval");
    expect(endpoints).not.toContain("approval-park");
  });

  /**
   * @case The internal route is still reachable in process
   * @preconditions The same context, dispatching the internal route by name
   * @expectedResult It parks and answers with the suspension acknowledgment.
   *   That is the whole contract: internal closes the ops door and the agent
   *   tool surface, and changes nothing for a caller inside the process,
   *   which is how `request-approval` gets its link.
   */
  test("still reach approval-park in process", async () => {
    t = await testContext()
      // A route that can park needs somewhere to park; the defaults are
      // in-memory under testContext, which is what a test wants.
      .with({ suspension: {} })
      .routes([approvalPark, requestApproval])
      .build();
    await t.startAndWaitReady();

    const parked = await t.client.sendDirect<
      unknown,
      { status?: string; token?: string }
    >("approval-park", {
      question: "Ship it",
      scope: "publish",
      approver: "ops@example.com",
      session: "demo",
    });

    expect(parked.status).toBe("suspended");
    expect(typeof parked.token).toBe("string");
  });

  /**
   * @case The state owners are absent from the capability surface too
   * @preconditions A context holding both owners and a route that submits to
   *   one of them
   * @expectedResult Only the submitting capability is discoverable. An owner
   *   is a lock, not a capability: an agent asked to schedule something should
   *   reach `schedule-task`, which validates what it is being asked, and the
   *   owner trusts its caller precisely because its caller is in this process.
   */
  test("keep the state owners off the capability surface", async () => {
    t = await testContext()
      .routes([schedulesOwner, scheduleTask, transcriptOwner])
      .build();
    await t.startAndWaitReady();

    const endpoints = t.ctx.capabilities().map((c) => c.endpoint);
    expect(endpoints).toContain("schedule-task");
    expect(endpoints).not.toContain("schedules-owner");
    expect(endpoints).not.toContain("transcript-owner");
  });
});
