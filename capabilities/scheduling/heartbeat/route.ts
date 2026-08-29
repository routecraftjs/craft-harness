import { craft, direct, log, timer } from "@routecraft/routecraft";
import { env } from "../../../env.js";
import type { ChatInput } from "../../chat/chat/route.js";

/**
 * Ask the agent, on a timer, whether anything needs doing.
 *
 * Disabled by default, and the default is the point. An agent that wakes
 * itself up spends money while nobody is watching, and a template that
 * shipped this on would bill every scaffolded project for a model call an
 * hour before its owner had read the README.
 *
 * Turning it on is one variable, `HEARTBEAT_ENABLED=true`. Off, the route is
 * registered and not started: no timer arms, nothing is dispatched, and
 * `/ops` reports it disabled with the variable to set. Visible and off beats
 * absent, because absent is also what a route nobody wrote looks like.
 *
 * A heartbeat lands in its own conversation, so its transcript is separate
 * from whatever a person is talking about.
 */
export default craft()
  .id("heartbeat")
  .description("Ask the agent on a timer whether anything needs doing.")
  .enabled(() =>
    env.HEARTBEAT_ENABLED ? true : "HEARTBEAT_ENABLED is not true",
  )
  .from(
    timer({
      interval: env.HEARTBEAT_INTERVAL_MS,
      // The first beat waits a full interval. A beat at boot would fire on
      // every restart, which turns a crash loop into a spend loop.
      delay: env.HEARTBEAT_INTERVAL_MS,
    }),
  )
  .transform((): ChatInput => ({
    session: "heartbeat",
    message:
      "Heartbeat. Check your scheduled tasks and your memory, and say whether anything needs doing now. If nothing does, say so in one line and stop.",
  }))
  .enrich(direct("chat"))
  .to(log());
