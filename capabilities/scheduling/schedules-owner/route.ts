import { craft, direct, jsonl, only } from "@routecraft/routecraft";
import { emptyWhenMissing } from "../../../shared/recover.js";
import {
  SCHEDULES_FILE,
  ScheduleOp,
  type ScheduleOutcome,
  type ScheduleResult,
  applyScheduleOp,
} from "../../../shared/schedule.js";

const OUTCOME = "harness.schedules.outcome";

/**
 * The one route that reads and writes the schedule file.
 *
 * Every scheduling capability is a read-modify-write of one file: read the
 * lines, add or drop or take some, write what is left. Four routes doing that
 * against the same path is four ways to lose a task, because the read and the
 * write are separate steps and nothing stops a second route landing between
 * them. `scheduler-tick` firing while `schedule-task` is adding writes back a
 * file that never had the new task in it, and neither route fails.
 *
 * So the file has an owner. Everything else states what it wants and submits
 * it here through `direct()`, and this route serialises the whole cycle with
 * `.concurrency({ max: 1 })`.
 *
 * The key is the file rather than the caller. Keying per route would give
 * each caller its own slot and close nothing: the race being closed is
 * between routes, and they contend for one file.
 *
 * Internal because it is a lock, not a capability. An agent asked to cancel
 * something should reach `cancel-schedule`, which validates what it is being
 * asked; this route trusts its caller because its caller is in this process.
 */
export default craft()
  .id("schedules-owner")
  .description("Serialise every read and write of the schedule file.")
  .input({ body: ScheduleOp })
  .concurrency({
    max: 1,
    // One file, so one slot. The selector names the resource rather than
    // relying on the route being the only writer, so sharding the schedule
    // per session later is a change to this line and nothing else.
    key: () => SCHEDULES_FILE,
  })
  .from<ScheduleOp>(direct({ internal: true }))
  // No file yet is an empty schedule. Every other read failure is declined:
  // the write below replaces the file with whatever this cycle computed.
  .error(emptyWhenMissing)
  .enrich(
    jsonl({ path: SCHEDULES_FILE }),
    only((lines: unknown[]) => lines, "lines"),
  )
  // Computed once, before the write, because the body has to become the array
  // the write persists and the answer to the caller needs what that array
  // does not carry: which tasks fired, and whether a cancellation matched.
  .header(OUTCOME, (exchange) =>
    applyScheduleOp(exchange.body, exchange.body.lines),
  )
  .transform(
    (_body, exchange) => (exchange.headers[OUTCOME] as ScheduleOutcome).keep,
  )
  // `.to()`, never `.tap()`. A tap is detached by contract: the framework
  // runs it on a tracked task and the pipeline continues immediately, so the
  // route answers its caller before the file has been written and the next
  // read sees the state before this one. That defeats the lock above, which
  // can only serialise work the route actually waits for.
  .to(jsonl({ path: SCHEDULES_FILE, createDirs: true }))
  .transform((keep, exchange): ScheduleResult => {
    const outcome = exchange.headers[OUTCOME] as ScheduleOutcome;
    return { tasks: keep, due: outcome.due, cancelled: outcome.cancelled };
  });
