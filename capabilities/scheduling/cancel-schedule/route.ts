import { craft, direct, jsonl, only } from "@routecraft/routecraft";
import { z } from "zod";
import { emptyWhenMissing } from "../../../shared/recover.js";
import { SCHEDULES_FILE, parseTasks } from "../../../shared/schedule.js";

/**
 * Drop a scheduled task.
 *
 * The file is rewritten without the named task, which is the same write the
 * scheduler and `schedule-task` make. Cancelling an id that is not there is
 * not an error: the caller wanted it gone and it is gone, and turning that
 * into a failure only teaches an agent to retry a cancellation.
 */

const CANCELLED_HEADER = "harness.schedule.cancelled";

export const CancelScheduleInput = z.object({
  id: z.string().min(1).describe("Id of the task to cancel."),
});
export type CancelScheduleInput = z.infer<typeof CancelScheduleInput>;

export default craft()
  .id("cancel-schedule")
  .description("Cancel a task the agent scheduled earlier.")
  .input({ body: CancelScheduleInput })
  .from<CancelScheduleInput>(direct())
  // No schedules file yet is an empty schedule, not a failure. The recovery
  // restores the input shape so the merge below reads the same body either
  // way; returning a bare array would drop the request.
  .error(emptyWhenMissing)
  .enrich(
    jsonl({ path: SCHEDULES_FILE }),
    only((lines: unknown[]) => lines, "lines"),
  )
  .header(CANCELLED_HEADER, (exchange) =>
    parseTasks(exchange.body.lines).some(
      (task) => task.id === exchange.body.id,
    ),
  )
  .transform((body) =>
    parseTasks(body.lines).filter((task) => task.id !== body.id),
  )
  .tap(jsonl({ path: SCHEDULES_FILE, createDirs: true }))
  .transform((remaining, exchange) => ({
    cancelled: exchange.headers[CANCELLED_HEADER] === true,
    remaining: remaining.length,
  }));
