import { craft, direct, jsonl, only } from "@routecraft/routecraft";
import { z } from "zod";
import { SCHEDULES_FILE, parseTasks } from "../../../shared/schedule.js";

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

export default craft()
  .id("list-schedules")
  .description("List the tasks the agent has scheduled for itself.")
  .input({ body: ListSchedulesInput })
  .from<ListSchedulesInput>(direct())
  // No schedules file yet is an empty schedule, not a failure. The recovery
  // restores the input shape so the merge below reads the same body either
  // way; returning a bare array would drop the request.
  .error((_error, exchange) => ({
    ...(exchange.body as ListSchedulesInput),
    lines: [] as unknown[],
  }))
  .enrich(
    jsonl({ path: SCHEDULES_FILE }),
    only((lines: unknown[]) => lines, "lines"),
  )
  .transform((body) => ({
    tasks: parseTasks(body.lines)
      .filter(
        (task) => body.session === undefined || task.session === body.session,
      )
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt)),
  }));
