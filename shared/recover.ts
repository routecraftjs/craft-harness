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
 * What the file adapter says when the path is not there.
 *
 * It is the only signal available. `throwFsError` in the framework maps the
 * errno to a fresh `new Error` with no `code` and no `cause`, so the ENOENT is
 * gone by the time a route's `.error()` sees it and matching the sentence is
 * what is left. It is specific enough not to collide: the same function words
 * a permissions failure "permission denied reading file" and everything else
 * "failed to read file".
 */
const ADAPTER_MISS = / adapter: (?:file|directory) not found: /;

/**
 * Whether an error means the file is not there yet.
 *
 * Two shapes, because two paths reach here. A direct `node:fs` call carries
 * `code: "ENOENT"`; an adapter read carries only the sentence above. Tests
 * for this predicate take the adapter's error from the adapter, never from a
 * hand-built stand-in, because the shape is the whole thing under test.
 */
function isMissingFile(error: unknown, depth = 0): boolean {
  if (error === null || typeof error !== "object" || depth > 4) return false;
  const record = error as Record<string, unknown>;
  if (record["code"] === "ENOENT") return true;
  const message = record["message"];
  if (typeof message === "string") {
    if (message.includes("ENOENT") || ADAPTER_MISS.test(message)) return true;
  }
  return isMissingFile(record["cause"], depth + 1);
}
