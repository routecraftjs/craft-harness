import { recovery, type Exchange } from "@routecraft/routecraft";

/**
 * Recovering a state file that is not there yet, and only that.
 *
 * Every route that reads one of the harness's JSONL state files goes on to
 * rewrite it whole. That makes the breadth of the recovery load-bearing: a
 * handler that answered "empty" to any read failure would turn a single
 * unparseable line into a transcript replaced by the message just sent, or a
 * schedule file replaced by the one task just added. Silently, because the
 * route then completes.
 *
 * A missing file is the one failure that genuinely means empty. Everything
 * else is declined with `recovery.rethrow()` and reaches the route's error
 * channel, where it is visible.
 *
 * @param exchange - The exchange at the point of failure
 * @param error - Whatever the read threw
 * @returns The input body with an empty `lines`, or a rethrow directive
 */
export function emptyWhenMissing(error: unknown, exchange: Exchange): unknown {
  if (!isMissingFile(error)) return recovery.rethrow();
  return {
    ...(exchange.body as Record<string, unknown>),
    lines: [] as unknown[],
  };
}

/**
 * The same rule for a route whose body the read replaces outright rather
 * than merging into, which is what a cron-sourced exchange has.
 *
 * @param error - Whatever the read threw
 * @returns An empty line list, or a rethrow directive
 */
export function noLinesWhenMissing(error: unknown): unknown {
  return isMissingFile(error) ? ([] as unknown[]) : recovery.rethrow();
}

/**
 * Whether an error is a missing file, looking through the wrapping the file
 * adapter applies on its way out.
 */
function isMissingFile(error: unknown, depth = 0): boolean {
  if (error === null || typeof error !== "object" || depth > 4) return false;
  const record = error as Record<string, unknown>;
  if (record["code"] === "ENOENT") return true;
  if (
    typeof record["message"] === "string" &&
    record["message"].includes("ENOENT")
  ) {
    return true;
  }
  return isMissingFile(record["cause"], depth + 1);
}
