import { craft, cron, log } from "@routecraft/routecraft";
import { direct } from "@routecraft/routecraft";
import { env } from "../../../env.js";
import type { ChatInput } from "../../chat/chat/route.js";
import type { ScheduleOp, ScheduleResult } from "../../../shared/schedule.js";

/**
 * The only thing in the harness that fires a schedule.
 *
 * A cron source reads the schedule file, takes whatever is due, writes the
 * rest back, and sends each due task to `chat` as a message. There is no
 * job runner and nothing in memory: the file is the state, so a task
 * survives a restart, and a tick that finds nothing due drops the exchange
 * and costs nothing.
 *
 * That last property is what the CI boot check leans on. With zero secrets
 * configured, this is the one route that reliably produces a terminal
 * outcome on its own, so `craft start --once` has something to wait for
 * that does not involve a model.
 *
 * Due tasks are removed from the file BEFORE they are dispatched, so a slow
 * dispatch cannot be fired twice by the next tick. Taking them and writing
 * back what is left is one operation inside `schedules-owner`, so a task
 * added while this tick is running is in the file the owner writes rather
 * than erased by it. A failed write means nothing was taken and the task
 * fires next tick: at-least-once is the right trade for a reminder, and the
 * alternative, dropping it and hoping, is not.
 */
export default craft()
  .id("scheduler-tick")
  .description("Fire scheduled tasks that have come due.")
  .from(cron(env.SCHEDULER_CRON))
  .transform((): ScheduleOp => ({
    op: "takeDue",
    now: new Date().toISOString(),
  }))
  .enrich(direct<ScheduleOp, ScheduleResult>("schedules-owner"))
  .filter((exchange) =>
    exchange.body.due.length > 0 ? true : { reason: "nothing due" },
  )
  .transform((result) => result.due)
  .split()
  .transform((task): ChatInput => ({
    session: task.session,
    message: `Scheduled task due now (id ${task.id}): ${task.task}`,
  }))
  .enrich(direct("chat"))
  .to(log());
