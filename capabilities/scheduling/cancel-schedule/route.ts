import { craft, direct, only } from "@routecraft/routecraft";
import { z } from "zod";
import type { ScheduleOp, ScheduleResult } from "../../../shared/schedule.js";

/**
 * Drop a scheduled task.
 *
 * The file is rewritten without the named task, which is the same write the
 * scheduler and `schedule-task` make. Cancelling an id that is not there is
 * not an error: the caller wanted it gone and it is gone, and turning that
 * into a failure only teaches an agent to retry a cancellation.
 */

export const CancelScheduleInput = z.object({
  id: z.string().min(1).describe("Id of the task to cancel."),
});
export type CancelScheduleInput = z.infer<typeof CancelScheduleInput>;

export default craft()
  .id("cancel-schedule")
  .description("Cancel a task the agent scheduled earlier.")
  .input({ body: CancelScheduleInput })
  .from<CancelScheduleInput>(direct())
  .transform((body): ScheduleOp => ({ op: "cancel", id: body.id }))
  // Whether the id was there and the rewrite without it are one operation
  // under the owner's lock. Read here and written here, they were two, and a
  // tick landing between them would have put the cancelled task back.
  .enrich(
    direct<ScheduleOp, ScheduleResult>("schedules-owner"),
    only((result: ScheduleResult) => result, "result"),
  )
  .transform((body) => ({
    cancelled: body.result.cancelled,
    remaining: body.result.tasks.length,
  }));
