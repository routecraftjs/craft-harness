import { recovery, type Exchange } from "@routecraft/routecraft";

/**
 * Recovering a state file that is not there yet, and only that.
 *
 * Every route that reads one of the harness's JSONL state files goes on to
 * rewrite it whole. That makes the narrowness of the recovery load-bearing: a
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
 * The sentence is the only signal available. `throwFsError` in the framework
 * maps the errno to a fresh `new Error` with no `code` and no `cause`, so the
 * ENOENT is gone by the time a route's `.error()` sees it. The pattern is
 * anchored at the start of the message because the adapter's generic branch
 * interpolates the driver's own text, and an unanchored match would find this
 * phrase inside whatever that text happens to contain.
 *
 * Delete this when the adapter preserves the errno: the `code` check below
 * covers the same case on its own. Re-read
 * `packages/routecraft/src/adapters/shared/fs-errors.ts` on every dependency
 * bump, because nothing here fails to compile when that wording moves.
 */
const ADAPTER_MISS = /^\w+ adapter: (?:file|directory) not found: /;

/**
 * Whether an error means the file is not there yet.
 *
 * Two shapes, because two paths reach here. A direct `node:fs` call carries
 * `code: "ENOENT"`, at the top of the error or anywhere down its cause chain;
 * an adapter read carries only the sentence above.
 *
 * The errno is never matched as free text. A parse failure quotes the
 * offending line back in its message, so a transcript holding the token
 * `ENOENT` would otherwise be read as a missing file and the route would
 * overwrite the conversation with the one message just sent.
 */
function isMissingFile(error: unknown, depth = 0): boolean {
  if (error === null || typeof error !== "object" || depth > 4) return false;
  const record = error as Record<string, unknown>;
  if (record["code"] === "ENOENT") return true;
  const message = record["message"];
  if (typeof message === "string" && ADAPTER_MISS.test(message)) return true;
  return isMissingFile(record["cause"], depth + 1);
}
