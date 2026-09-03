import { describe, expect, test } from "bun:test";
import { emptyWhenMissing, noLinesWhenMissing } from "../shared/recover.js";
import type { Exchange } from "@routecraft/routecraft";

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
