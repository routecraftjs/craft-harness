import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonl } from "@routecraft/routecraft";
import { emptyWhenMissing, noLinesWhenMissing } from "../shared/recover.js";
import type { Exchange } from "@routecraft/routecraft";

/**
 * The error the jsonl adapter actually throws for a path that is not there.
 *
 * Built by asking the adapter rather than by hand. Hand-built errors are what
 * let the original bug ship: they carried `code: "ENOENT"`, the recovery
 * matched on it, and every test passed while the adapter's own error, which
 * carries no code and no cause, was declined on the first tick of a fresh
 * scaffold.
 */
async function realAdapterMiss(): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "rc-miss-"));
  const adapter = jsonl({ path: join(dir, "absent.jsonl") }) as unknown as {
    fetch: (ex: unknown, ctx: unknown) => Promise<unknown>;
  };
  try {
    await adapter.fetch({ headers: {}, body: {} }, {});
    throw new Error("the adapter did not throw for a missing file");
  } catch (err) {
    return err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const exchange = {
  body: { session: "demo", message: "hi" },
} as unknown as Exchange;

function missing(): Error & { code: string } {
  return Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
}

describe("emptyWhenMissing", () => {
  /**
   * @case A file that is not there yet recovers as an empty one
   * @preconditions An ENOENT from the jsonl read on a fresh scaffold
   * @expectedResult The input body with empty lines, so the route continues
   */
  test("recovers a missing file as empty", () => {
    const result = emptyWhenMissing(missing(), exchange) as {
      session: string;
      lines: unknown[];
    };
    expect(result.session).toBe("demo");
    expect(result.lines).toEqual([]);
  });

  /**
   * @case ENOENT wrapped by the adapter is still recognised
   * @preconditions The framework wraps the driver error on its way out
   * @expectedResult Recovered, because the cause chain is searched
   */
  test("looks through the adapter's wrapping", () => {
    const wrapped = new Error("Failed to read file", { cause: missing() });
    expect(emptyWhenMissing(wrapped, exchange)).toMatchObject({ lines: [] });
  });

  /**
   * @case A malformed line is declined, not recovered
   * @preconditions A JSON parse failure on a file that does exist
   * @expectedResult A rethrow directive, because the routes that use this go
   *   on to rewrite the file whole and would otherwise replace it with only
   *   the turn just added
   */
  test("declines a parse failure rather than emptying the file", () => {
    const parseError = new SyntaxError("Unexpected end of JSON input");
    const result = emptyWhenMissing(parseError, exchange);
    expect(result).not.toMatchObject({ lines: [] });
  });

  /**
   * @case A permissions failure is declined
   * @preconditions EACCES on a file that exists
   * @expectedResult A rethrow directive rather than a silent overwrite
   */
  test("declines a permissions failure", () => {
    const denied = Object.assign(new Error("EACCES"), { code: "EACCES" });
    expect(emptyWhenMissing(denied, exchange)).not.toMatchObject({ lines: [] });
  });
});

describe("against the adapter's own error", () => {
  /**
   * @case The recovery recognises what the framework actually throws
   * @preconditions The error obtained by asking the jsonl adapter to read a
   *   path that does not exist, not one constructed in the test
   * @expectedResult Recovered. The adapter maps the errno to a fresh Error
   *   with no code and no cause, so an errno-only check declines it and the
   *   first tick of a fresh scaffold fails the boot.
   */
  test("recovers the jsonl adapter's missing-file error", async () => {
    const err = await realAdapterMiss();
    expect(noLinesWhenMissing(err)).toEqual([]);
    expect(emptyWhenMissing(err, exchange)).toMatchObject({ lines: [] });
  });

  /**
   * @case A permissions failure is still declined
   * @preconditions The adapter's wording for EACCES, which shares the prefix
   *   the recovery matches on but not the rest
   * @expectedResult Declined, so widening the match to the adapter's sentence
   *   did not widen it to every adapter failure
   */
  test("still declines the adapter's permission error", () => {
    const denied = new Error(
      "file adapter: permission denied reading file: /x/y.jsonl",
    );
    expect(noLinesWhenMissing(denied)).not.toEqual([]);
    expect(emptyWhenMissing(denied, exchange)).not.toMatchObject({ lines: [] });
  });

  /**
   * @case A parse failure is still declined
   * @preconditions The adapter's generic read wording
   * @expectedResult Declined, because the file exists and rewriting it whole
   *   from an empty read would destroy it
   */
  test("still declines the adapter's generic read error", () => {
    const broken = new Error("file adapter: failed to read file: bad json");
    expect(noLinesWhenMissing(broken)).not.toEqual([]);
  });
});

describe("noLinesWhenMissing", () => {
  /**
   * @case A missing schedules file is an empty schedule
   * @preconditions ENOENT on the tick's read, the fresh-scaffold path
   * @expectedResult An empty array, so the tick fires nothing and writes nothing
   */
  test("recovers a missing file as no lines", () => {
    expect(noLinesWhenMissing(missing())).toEqual([]);
  });

  /**
   * @case Any other failure is declined
   * @preconditions A truncated final line, which a crash mid-write leaves
   * @expectedResult A rethrow directive, because the tick rewrites the file
   *   with whatever survived and would otherwise drop every pending task
   */
  test("declines a parse failure rather than dropping every task", () => {
    const parseError = new SyntaxError("Unexpected end of JSON input");
    expect(noLinesWhenMissing(parseError)).not.toEqual([]);
  });
});
