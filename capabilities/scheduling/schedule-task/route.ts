import { craft, direct, jsonl, only } from "@routecraft/routecraft";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  SCHEDULES_FILE,
  type ScheduledTask,
  parseTasks,
} from "../../../shared/schedule.js";
import { SessionId } from "../../../shared/transcript.js";

/**
 * Ask to be woken up later.
 *
 * Writing a line to a file is the whole of scheduling here. Nothing runs in
 * the background on this route's behalf: `scheduler-tick` reads the same
 * file on its own cron and does the waking, which means a task survives a
 * restart because the file does, not because anything was kept alive.
 *
 * `inMinutes` exists because a model has no clock. Asking it for an absolute
 * timestamp gets an absolute timestamp that is confidently wrong; asking for
 * a delay gets a delay, and the harness supplies the clock.
 */

export const ScheduleTaskInput = z
  .object({
    task: z
      .string()
      .min(1)
      .describe("What to do when this fires. Phrased as a message to you."),
    inMinutes: z.coerce
      .number()
      .int()
      .positive()
      .max(525_600)
      .optional()
      .describe("Fire this many minutes from now."),
    dueAt: z.iso
      .datetime()
      .optional()
      .describe("Exact UTC moment to fire. Use inMinutes unless you are sure."),
    session: SessionId.default("scheduled").describe(
      "Conversation the reminder lands in.",
    ),
  })
  .refine(
    (body) => (body.inMinutes === undefined) !== (body.dueAt === undefined),
    { message: "Give exactly one of inMinutes or dueAt." },
  );
export type ScheduleTaskInput = z.infer<typeof ScheduleTaskInput>;

export default craft()
  .id("schedule-task")
  .description("Schedule a task for the agent to pick up later.")
  .input({ body: ScheduleTaskInput })
  .from<ScheduleTaskInput>(direct())
  // No schedules file yet is an empty schedule, not a failure. The recovery
  // restores the input shape so the merge below reads the same body either
  // way; returning a bare array would drop the request.
  .error((_error, exchange) => ({
    ...(exchange.body as ScheduleTaskInput),
    lines: [] as unknown[],
  }))
  .enrich(
    jsonl({ path: SCHEDULES_FILE }),
    only((lines: unknown[]) => lines, "lines"),
  )
  .transform((body) => {
    const now = new Date();
    const dueAt =
      body.dueAt ??
      new Date(now.getTime() + (body.inMinutes ?? 0) * 60_000).toISOString();
    const created: ScheduledTask = {
      id: randomUUID(),
      dueAt,
      task: body.task,
      session: body.session,
      createdAt: now.toISOString(),
    };
    // The new task goes last, which is what lets the write below be the
    // whole file and the step after it recover the one that was created.
    return [...parseTasks(body.lines), created];
  })
  // The whole file is rewritten rather than appended to, so add, cancel and
  // fire are one operation with one shape and cannot interleave into a file
  // that holds a task twice.
  .tap(
    jsonl({
      path: SCHEDULES_FILE,
      createDirs: true,
    }),
  )
  .transform((all) => all[all.length - 1]!);
