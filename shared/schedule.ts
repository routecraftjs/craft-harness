import { z } from "zod";
import { SCHEDULES_FILE } from "./paths.js";
import { SessionId } from "./transcript.js";

/**
 * The schedule file: work the agent asked to be woken up for.
 *
 * One JSON Lines file, one line per pending task, rewritten whole whenever
 * an entry is added, cancelled or fired. It is deliberately not a queue or a
 * job runner: a scheduled task is a message the harness will send itself
 * later, and the whole mechanism is the tick route reading this file.
 */

export { SCHEDULES_FILE };

/** One thing to do later. */
export const ScheduledTask = z.object({
  id: z.string().min(1),
  /** When the tick should fire it. ISO 8601, always UTC. */
  dueAt: z.iso.datetime(),
  /** What to say to the agent when it fires. */
  task: z.string().min(1),
  /** Conversation the reminder lands in. */
  session: SessionId,
  createdAt: z.iso.datetime(),
});
export type ScheduledTask = z.infer<typeof ScheduledTask>;

/**
 * Keep the lines that parse as tasks, dropping the rest.
 *
 * A line that will not parse is skipped rather than failing the tick. The
 * tick is the only thing that ever fires a schedule, so a single malformed
 * line taking the whole scheduler down would silently stop every other task
 * in the file.
 */
export function parseTasks(lines: readonly unknown[]): ScheduledTask[] {
  const tasks: ScheduledTask[] = [];
  for (const line of lines) {
    const parsed = ScheduledTask.safeParse(line);
    if (parsed.success) tasks.push(parsed.data);
  }
  return tasks;
}

/** Whether a task is due at the given moment. */
export function isDue(task: ScheduledTask, now: Date): boolean {
  return new Date(task.dueAt).getTime() <= now.getTime();
}

/**
 * What a caller wants done to the schedule file.
 *
 * One shape for all four, because the point of naming them is that they go
 * through one owner: a caller states the intent and the owner performs the
 * whole read-modify-write under its lock. A caller that read the file itself
 * and sent back the result would have reopened the race this closes.
 */
export const ScheduleOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("list") }),
  z.object({ op: z.literal("add"), task: ScheduledTask }),
  z.object({ op: z.literal("cancel"), id: z.string().min(1) }),
  z.object({ op: z.literal("takeDue"), now: z.iso.datetime() }),
]);
export type ScheduleOp = z.infer<typeof ScheduleOp>;

/**
 * What the owner answers, whichever operation was asked for.
 *
 * One shape for four operations, so `due` is empty for everything but a tick
 * and `cancelled` is meaningful only after a cancel. `tasks` is both what was
 * written and what the caller is told, because the write is a whole-file
 * rewrite and there is nothing the owner keeps back.
 */
export interface ScheduleResult {
  /** The schedule after the operation, which is what was written. */
  tasks: ScheduledTask[];
  /** Tasks this operation took out to be fired. Empty for everything but a tick. */
  due: ScheduledTask[];
  /** Whether a cancellation matched an id that was there. */
  cancelled: boolean;
  /**
   * The task an `add` created, named rather than left to be recovered by
   * position. Undefined for every other operation.
   */
  added?: ScheduledTask;
  /**
   * Whether this operation changes the file.
   *
   * A read must not write. `parseTasks` drops lines the schema rejects, so
   * writing back what a read parsed would erase a line a person hand-edited
   * or a future schema version wrote, permanently and with no error. It would
   * also create a schedule file for a caller that only asked what was in one.
   */
  written: boolean;
}

/**
 * Decide what one operation does to the schedule, without performing it.
 *
 * Pure, so the decision is testable on its own and the owner route stays a
 * pipeline. Every arm returns the whole file rather than a delta, because the
 * write is a whole-file rewrite either way and a delta would be a second
 * representation to keep honest.
 *
 * @param op What the caller asked for
 * @param lines The file as read, unparsed
 */
export function applyScheduleOp(
  op: ScheduleOp,
  lines: readonly unknown[],
): ScheduleResult {
  const tasks = parseTasks(lines);
  switch (op.op) {
    case "list":
      return { tasks, due: [], cancelled: false, written: false };
    case "add":
      return {
        tasks: [...tasks, op.task],
        due: [],
        cancelled: false,
        added: op.task,
        written: true,
      };
    case "cancel":
      return {
        tasks: tasks.filter((task) => task.id !== op.id),
        due: [],
        cancelled: tasks.some((task) => task.id === op.id),
        written: true,
      };
    case "takeDue": {
      const now = new Date(op.now);
      return {
        tasks: tasks.filter((task) => !isDue(task, now)),
        due: tasks.filter((task) => isDue(task, now)),
        cancelled: false,
        written: true,
      };
    }
  }
}
