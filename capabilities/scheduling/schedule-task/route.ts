import { craft, direct, only } from "@routecraft/routecraft";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type ScheduleOp,
  type ScheduleResult,
  type ScheduledTask,
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
  .transform((body): ScheduleOp => {
    const now = new Date();
    const dueAt =
      body.dueAt ??
      new Date(now.getTime() + (body.inMinutes ?? 0) * 60_000).toISOString();
    return {
      op: "add",
      task: {
        id: randomUUID(),
        dueAt,
        task: body.task,
        session: body.session,
        createdAt: now.toISOString(),
      },
    };
  })
  // The owner performs the read, the append and the write under one lock, so
  // a tick firing at the same moment cannot write back a file this task was
  // never in.
  .enrich(
    direct<ScheduleOp, ScheduleResult>("schedules-owner"),
    only((result: ScheduleResult) => result, "result"),
  )
  .transform((body): ScheduledTask => {
    if (body.result.added === undefined) {
      throw new Error("schedules-owner did not report the task it created");
    }
    return body.result.added;
  });
