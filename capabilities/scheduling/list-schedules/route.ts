import { craft, direct, only } from "@routecraft/routecraft";
import { z } from "zod";
import type { ScheduleOp, ScheduleResult } from "../../../shared/schedule.js";

/**
 * Show what is scheduled.
 *
 * The schedule file is the state, so listing it is a read of that file and
 * nothing else. Ordered by when each task fires rather than when it was
 * created, because "what happens next" is the question this answers.
 */

export const ListSchedulesInput = z.object({
  session: z
    .string()
    .optional()
    .describe("Only tasks landing in this conversation."),
});
export type ListSchedulesInput = z.infer<typeof ListSchedulesInput>;

/**
 * The enrich replaces the body with the owner's answer, so the caller's
 * filter has to survive somewhere the body is not.
 */
const SESSION_FILTER = "harness.schedules.session";

export default craft()
  .id("list-schedules")
  .description("List the tasks the agent has scheduled for itself.")
  .input({ body: ListSchedulesInput })
  .from<ListSchedulesInput>(direct())
  .header(SESSION_FILTER, (exchange) => exchange.body.session ?? "")
  .transform((): ScheduleOp => ({ op: "list" }))
  // A read goes through the owner too. It costs a slot on a lock nothing else
  // is holding for long, and it buys a listing that is never a half-written
  // file: the alternative is reading beside a rewrite that is mid-flight.
  .enrich(
    direct<ScheduleOp, ScheduleResult>("schedules-owner"),
    only((result: ScheduleResult) => result, "result"),
  )
  .transform((body, exchange) => {
    const session = String(exchange.headers[SESSION_FILTER] ?? "");
    return {
      tasks: body.result.tasks
        .filter((task) => session === "" || task.session === session)
        .sort((left, right) => left.dueAt.localeCompare(right.dueAt)),
    };
  });
