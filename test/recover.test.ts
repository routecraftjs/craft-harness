import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directory, jsonl } from "@routecraft/routecraft";
import { emptyWhenMissing } from "../shared/recover.js";
import type { Enricher, Exchange } from "@routecraft/routecraft";

const exchange = {
  body: { session: "demo", message: "hi" },
} as unknown as Exchange;

/**
 * The error an adapter really throws, obtained by making it throw.
 *
 * The recovery matches on the adapter's wording, so a stand-in built in the
 * test would pin the wording this file assumes rather than the wording the
 * framework emits. `build` populates a scratch directory and returns the path
 * to read; whatever comes back out is the framework's own error.
 *
 * @param adapterFor - Adapter under test, given the path `build` returned
 * @param build - Populates the scratch directory, returns the path to read
 * @returns The error the adapter threw
 */
async function adapterError(
  adapterFor: (path: string) => Enricher<unknown, unknown[]>,
  build: (dir: string) => Promise<string>,
): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "rc-recover-"));
  let thrown: unknown;
  let threw = false;
  try {
    await adapterFor(await build(dir)).fetch(exchange);
  } catch (error) {
    threw = true;
    thrown = error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  if (!threw) throw new Error("the adapter returned instead of throwing");
  return thrown;
}

const readJsonl = (path: string) =>
  jsonl({ path }) as Enricher<unknown, unknown[]>;
const readDir = (path: string) =>
  directory({ path }) as unknown as Enricher<unknown, unknown[]>;

function withLine(line: string): (dir: string) => Promise<string> {
  return async (dir) => {
    const path = join(dir, "present.jsonl");
    await writeFile(path, `${line}\n`);
    return path;
  };
}

function missing(): Error & { code: string } {
  return Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
}

describe("emptyWhenMissing", () => {
  /**
   * @case A file that is not there yet recovers as an empty one
   * @preconditions An ENOENT from a direct node:fs read
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
   * @case ENOENT carried on the cause chain is still recognised
   * @preconditions A wrapper error whose cause holds the errno
   * @expectedResult Recovered, because the chain is walked
   */
  test("looks through the wrapping", () => {
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

describe("against the adapter's own errors", () => {
  /**
   * @case The recovery recognises what the framework actually throws
   * @preconditions The error from asking the jsonl adapter for a path that
   *   does not exist
   * @expectedResult Recovered. The adapter throws a bare Error with no code
   *   and no cause, so an errno-only predicate declines it and the first
   *   scheduler tick of a fresh scaffold fails the boot.
   */
  test("recovers a missing file", async () => {
    const error = await adapterError(readJsonl, async (dir) =>
      join(dir, "absent.jsonl"),
    );
    expect(emptyWhenMissing(error, exchange)).toMatchObject({ lines: [] });
  });

  /**
   * @case A missing parent directory is the same case
   * @preconditions A path under a directory that was never created, which is
   *   state/transcripts/ on a fresh scaffold
   * @expectedResult Recovered, so the first chat of a new session is a new
   *   conversation rather than a failure
   */
  test("recovers a missing parent directory", async () => {
    const error = await adapterError(readJsonl, async (dir) =>
      join(dir, "never-made", "absent.jsonl"),
    );
    expect(emptyWhenMissing(error, exchange)).toMatchObject({ lines: [] });
  });

  /**
   * @case A missing directory is recognised through the directory adapter
   * @preconditions The error from asking the directory adapter to scan a path
   *   that does not exist
   * @expectedResult Recovered, which is what lets a directory read take these
   *   handlers without the pattern having to change
   */
  test("recovers a missing directory", async () => {
    const error = await adapterError(readDir, async (dir) => join(dir, "gone"));
    expect(emptyWhenMissing(error, exchange)).toMatchObject({ lines: [] });
  });

  /**
   * @case A read that fails for any other reason is declined
   * @preconditions The adapter pointed at a directory, so the read fails with
   *   EISDIR and the adapter's generic wording rather than its missing one
   * @expectedResult Declined, so widening the match to the adapter's sentence
   *   did not widen it to every adapter failure
   */
  test("declines a read that fails for another reason", async () => {
    const error = await adapterError(readJsonl, async (dir) => dir);
    expect(emptyWhenMissing(error, exchange)).not.toMatchObject({ lines: [] });
  });

  /**
   * @case A stored line that mentions an errno does not empty the file
   * @preconditions A transcript whose line is not valid JSON and contains the
   *   token ENOENT, which the parser quotes back in its message
   * @expectedResult Declined. Matching the errno as free text would read this
   *   as a missing file, and chat's first write is a whole-file overwrite, so
   *   the conversation would be replaced by the message just sent.
   */
  test("declines a parse failure that quotes an errno", async () => {
    const error = await adapterError(
      readJsonl,
      withLine("ENOENT: no such file"),
    );
    expect(emptyWhenMissing(error, exchange)).not.toMatchObject({ lines: [] });
  });

  /**
   * @case A permissions failure is declined
   * @preconditions The adapter's EACCES wording, transcribed rather than
   *   provoked: the test suite runs as root in CI, and root does not get
   *   EACCES. The wording is pinned by the sibling cases above, which do come
   *   from the adapter.
   * @expectedResult Declined
   */
  test("declines the adapter's permission wording", () => {
    const denied = new Error(
      "file adapter: permission denied reading file: /x/y.jsonl",
    );
    expect(emptyWhenMissing(denied, exchange)).not.toMatchObject({ lines: [] });
  });
});
