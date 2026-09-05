import { craft, direct, jsonl, only } from "@routecraft/routecraft";
import type { Exchange } from "@routecraft/routecraft";
import { emptyWhenMissing } from "../../../shared/recover.js";
import {
  SCHEDULES_FILE,
  ScheduleOp,
  type ScheduleResult,
  applyScheduleOp,
} from "../../../shared/schedule.js";

const OUTCOME = "harness.schedules.outcome";

/**
 * The decision this exchange reached, which the body cannot carry because the
 * body has to become the array the write persists.
 *
 * Throws rather than asserting: a missing header means the step order changed,
 * and failing inside the lock is better than writing whatever `undefined`
 * parses to.
 */
function outcomeOf(exchange: Exchange<unknown>): ScheduleResult {
  const outcome = exchange.headers[OUTCOME];
  if (outcome === undefined) {
    throw new Error("schedules-owner: the outcome header was not set");
  }
  return outcome as ScheduleResult;
}

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
  // The deadline sits outside the lock in the pre-from chain, so it bounds the
  // wait for a slot as well as the work. Without it a write that never returns,
  // a hung mount or a full disk, parks every scheduling caller in an unbounded
  // queue and the harness stops answering with nothing logged.
  .timeout("30s")
  .concurrency({
    max: 1,
    // A backlog this long means something is wrong upstream, and RC5026 tells
    // the caller so rather than growing the queue in silence.
    maxQueue: 100,
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
  .transform((_body, exchange) => outcomeOf(exchange).tasks)
  // `.to()`, not `.tap()`: a tap is detached and would answer before the write.
  // Gated on `written`, because a read must not rewrite the file: the parse
  // drops lines the schema rejects, so answering a query would erase them.
  .to(async (exchange) => {
    if (!outcomeOf(exchange).written) return;
    await jsonl({ path: SCHEDULES_FILE, createDirs: true }).send(exchange);
  })
  .transform((_written, exchange): ScheduleResult => outcomeOf(exchange));
