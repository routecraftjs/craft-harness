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
 * Turning it on is one variable, `HEARTBEAT_ENABLED=true`. It is off by
 * being unconstructed rather than by a runtime flag: with the flag unset
 * this module exports no routes, so there is no timer, no route in the
 * registry, and nothing to notice in a log.
 *
 * A heartbeat lands in its own conversation, so its transcript is separate
 * from whatever a person is talking about.
 */
const heartbeat = craft()
  .id("heartbeat")
  .description("Ask the agent on a timer whether anything needs doing.")
  .from(
    timer({
      intervalMs: env.HEARTBEAT_INTERVAL_MS,
      // The first beat waits a full interval. A beat at boot would fire on
      // every restart, which turns a crash loop into a spend loop.
      delayMs: env.HEARTBEAT_INTERVAL_MS,
    }),
  )
  .transform((): ChatInput => ({
    session: "heartbeat",
    message:
      "Heartbeat. Check your scheduled tasks and your memory, and say whether anything needs doing now. If nothing does, say so in one line and stop.",
  }))
  .enrich(direct("chat"))
  .to(log());

export default env.HEARTBEAT_ENABLED ? [heartbeat] : [];
