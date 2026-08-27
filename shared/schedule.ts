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
