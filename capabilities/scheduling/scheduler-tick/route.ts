import { craft, cron, jsonl, log } from "@routecraft/routecraft";
import { direct } from "@routecraft/routecraft";
import { env } from "../../../env.js";
import type { ChatInput } from "../../chat/chat/route.js";
import {
  SCHEDULES_FILE,
  type ScheduledTask,
  isDue,
  parseTasks,
} from "../../../shared/schedule.js";

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
 * dispatch cannot be fired twice by the next tick. The rewrite runs as a
 * multicast path, which is isolated from the main flow: a failed rewrite
 * leaves the task in the file and it fires again next tick. At-least-once is
 * the right trade for a reminder, and the alternative (drop it and hope) is
 * not.
 */
export default craft()
  .id("scheduler-tick")
  .description("Fire scheduled tasks that have come due.")
  .from(cron(env.SCHEDULER_CRON))
  // No schedules file yet is an empty schedule, not a failure. This is the
  // path a fresh scaffold takes on every tick.
  .error(() => [] as unknown[])
  // A bare enrich, not `only()`: a cron exchange has no body to merge into,
  // so the lines replace it and the transform below reads them directly.
  .enrich(jsonl({ path: SCHEDULES_FILE }))
  .transform((lines: unknown[]) => {
    const now = new Date();
    const tasks = parseTasks(lines);
    return {
      due: tasks.filter((task) => isDue(task, now)),
      pending: tasks.filter((task) => !isDue(task, now)),
    };
  })
  .filter((exchange) =>
    exchange.body.due.length > 0 ? true : { reason: "nothing due" },
  )
  .multicast((path) =>
    path
      .transform((body): ScheduledTask[] => body.pending)
      .to(jsonl({ path: SCHEDULES_FILE, createDirs: true })),
  )
  .transform((body) => body.due)
  .split()
  .transform((task): ChatInput => ({
    session: task.session,
    message: `Scheduled task due now (id ${task.id}): ${task.task}`,
  }))
  .enrich(direct("chat"))
  .to(log());
