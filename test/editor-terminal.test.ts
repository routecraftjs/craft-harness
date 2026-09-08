import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import listFiles from "../capabilities/editor/list-files/route.js";
import runCommand, {
  ALLOWLIST,
  RunCommandInput,
} from "../capabilities/editor/run-command/route.js";
import searchFiles from "../capabilities/editor/search-files/route.js";
import {
  CAPABLE_EDITOR,
  runWithScriptedEditor,
} from "./support/scripted-editor.js";

/**
 * `run-command`, and the two capabilities that wrap it, against a scripted
 * editor that spawns real processes.
 *
 * Every case here runs a real agent turn through the real ACP mount, so what
 * is asserted is what an editor on the other end would actually see: which
 * protocol calls arrived, in what order, and what the child process did.
 * That matters more here than anywhere else in this repository, because this
 * capability has none of `bash-runner`'s kernel isolation. It runs as the
 * person. The guardrails are the whole boundary, and a guardrail nobody
 * exercises is a comment.
 */
describe("run-command in the editor's terminal", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.stop();
    t = undefined;
  });

  const runCase = (
    input: unknown,
    extra: Partial<Parameters<typeof runWithScriptedEditor>[0]> = {},
  ): ReturnType<typeof runWithScriptedEditor> =>
    runWithScriptedEditor({
      routes: [runCommand, listFiles, searchFiles],
      route: "run-command",
      input,
      ...extra,
    });

  /**
   * @case (a) A command runs, answers, and the terminal is released
   * @preconditions An editor offering a terminal, `echo` on the allowlist
   * @expectedResult The output reaches the agent, the exit code is 0, and
   *   `terminal/release` was called. A terminal nothing closes is a resource
   *   left open in somebody's editor that this process can never reach again.
   */
  test("a: echo hello returns its text, exits 0, and releases", async () => {
    const run = await runCase({ command: "echo", args: ["hello"] });

    expect(run.callsTo("terminal/create")).toHaveLength(1);
    expect(run.callsTo("terminal/release")).toHaveLength(1);
    expect(run.toolOutput).toMatchObject({ exitCode: 0, timedOut: false });
    expect(String(run.toolOutput?.["output"])).toContain("hello");
  });

  /**
   * @case (b) It runs in the project, not where the instance runs
   * @preconditions The session opened on a temporary directory
   * @expectedResult Printing the working directory returns that directory,
   *   and this process's own directory never appears. The route omits `cwd`
   *   precisely so the editor answers with the project it has open; naming
   *   one would be this instance guessing at somebody else's filesystem.
   */
  test("b: runs in the session's directory, never the instance's", async () => {
    const run = await runCase({ command: "pwd", args: [] });

    const output = String(run.toolOutput?.["output"] ?? "");
    expect(output).toContain(run.cwd);
    expect(output).not.toContain(process.cwd());
    expect(run.callsTo("terminal/create")[0]?.params["cwd"]).toBeUndefined();
  });

  /**
   * @case (c) A failing command is a failed tool call carrying its reason
   * @preconditions `bun` on the allowlist, running a script that exits 3
   *   after writing to standard error
   * @expectedResult The agent sees a failed tool call whose text carries the
   *   exit code and the error output. A non-zero exit reported as a success
   *   with a field to notice is a result a model reads straight past.
   */
  test("c: exit 3 comes back as a failed call with its stderr", async () => {
    const run = await runCase({
      command: "bun",
      args: ["-e", "console.error('the reason'); process.exit(3)"],
    });

    expect(run.toolFailed).toBe(true);
    // The reason reaches the AGENT, which is what the case is about. The
    // editor is told only that the call failed and which class of error it
    // was, which is a routecraft observation rather than something this
    // capability can fix from here.
    expect(run.modelSaw).toContain("exited 3");
    expect(run.modelSaw).toContain("the reason");
    expect(run.callsTo("terminal/release")).toHaveLength(1);
  });

  /**
   * @case (d) Output is bounded, and the result says it was cut
   * @preconditions A command writing far more than the cap
   * @expectedResult The editor was asked for a byte limit, the text comes
   *   back at or under it, and `truncated` is true. One runaway command must
   *   not become the whole context window, and the agent has to be told the
   *   text it is reading is a tail rather than the whole thing.
   */
  test("d: unbounded output is truncated at the cap and reported", async () => {
    const run = await runCase({
      command: "bun",
      args: [
        "-e",
        "for (let i = 0; i < 20000; i += 1) console.log('x'.repeat(64))",
      ],
    });

    const limit = run.callsTo("terminal/create")[0]?.params["outputByteLimit"];
    expect(typeof limit).toBe("number");
    expect(run.toolOutput?.["truncated"]).toBe(true);
    expect(String(run.toolOutput?.["output"]).length).toBeLessThanOrEqual(
      Number(limit),
    );
  });

  /**
   * @case (e) A command past the timeout is killed, reported, and released
   * @preconditions A sleep longer than the capability's timeout, with the
   *   timeout shortened for the test through the same constant the route
   *   reads
   * @expectedResult The editor records `terminal/kill` and then
   *   `terminal/release`, and the agent is told it timed out. The release is
   *   the part that is easy to lose: mutation-checked by removing it, which
   *   fails this case.
   */
  test("e: a command past the timeout is killed and released", async () => {
    const run = await runCase({
      command: "bun",
      args: ["-e", "await Bun.sleep(30000)"],
    });

    expect(run.callsTo("terminal/kill")).toHaveLength(1);
    expect(run.callsTo("terminal/release")).toHaveLength(1);
    expect(run.toolFailed).toBe(true);
    expect(run.modelSaw).toContain("ran longer than");
  });

  /**
   * @case (f) Cancelling stops the turn, and the terminal is left behind
   * @preconditions A long command, with the person cancelling once the wait
   *   is in flight, and four seconds of drain afterwards so nothing is
   *   attributed to closing the connection too early
   * @expectedResult The prompt returns `cancelled`. It also records that
   *   NEITHER `terminal/kill` NOR `terminal/release` arrives, which is not
   *   what this capability asks for and not what it tries to do.
   *
   *   The route wraps the whole lifecycle so that a cancelled turn kills the
   *   child and releases the terminal on the way out. It cannot: once the
   *   turn is cancelled its surface is gone, so every call the cleanup would
   *   make has nowhere to go. The command keeps running in the person's
   *   editor and the terminal is never released.
   *
   *   This case pins the defect rather than hiding it. When routecraft lets
   *   a route finish its cleanup against a cancelled turn, this test fails,
   *   and the failure is the signal to change the two expectations below to
   *   `toHaveLength(1)` and delete this paragraph.
   */
  test("f: cancelling returns cancelled, and cannot clean up (pins a gap)", async () => {
    const run = await runCase(
      { command: "bun", args: ["-e", "await Bun.sleep(30000)"] },
      { cancelOn: "terminal/wait_for_exit", drainMs: 4000 },
    );

    expect(run.stopReason).toBe("cancelled");
    expect(run.callsTo("terminal/kill")).toHaveLength(0);
    expect(run.callsTo("terminal/release")).toHaveLength(0);
  });

  /**
   * @case (g) The allowlist decides, and a refusal runs nothing
   * @preconditions A command that is not on the allowlist, with the editor
   *   refusing permission
   * @expectedResult The person was asked, no terminal was created, and the
   *   agent is told nothing ran. This is the boundary: without the tier that
   *   contains `bash-runner`, the only thing between a model and the
   *   person's machine is this question.
   */
  test("g: a refused permission creates no terminal", async () => {
    const run = await runCase(
      { command: "curl", args: ["https://example.com"] },
      { permission: () => ({ outcome: "cancelled" }) },
    );

    expect(run.callsTo("session/request_permission")).toHaveLength(1);
    expect(run.callsTo("terminal/create")).toHaveLength(0);
    expect(run.toolOutput?.["refused"]).toBeDefined();
  });

  /**
   * @case (g) A granted permission runs it, once
   * @preconditions The same command, with the editor allowing it
   * @expectedResult Exactly one terminal. Asking twice, or running twice
   *   after one yes, are both ways a person's answer stops meaning what they
   *   thought it meant.
   */
  test("g: a granted permission runs the command exactly once", async () => {
    const run = await runCase(
      // `sleep` is deliberately NOT on the pinned allowlist, which is what
      // makes this the granted-permission path rather than the quiet one.
      { command: "sleep", args: ["0"] },
      { permission: () => ({ outcome: "selected", optionId: "allow" }) },
    );

    expect(run.callsTo("session/request_permission")).toHaveLength(1);
    expect(run.callsTo("terminal/create")).toHaveLength(1);
  });

  /**
   * @case (h) Arguments reach the editor as a list
   * @preconditions A shell line passed as one argument
   * @expectedResult The editor receives it as one element and no marker file
   *   is created. The editor spawns without a shell, so there is no spelling
   *   of this input that reaches a shell metacharacter.
   */
  test("h: a shell line in one argument stays one argument", async () => {
    const run = await runCase({
      command: "echo",
      args: ["hello; touch marker"],
    });

    expect(run.callsTo("terminal/create")[0]?.params["args"]).toEqual([
      "hello; touch marker",
    ]);
    expect(run.leftInProject).not.toContain("marker");
    expect(String(run.toolOutput?.["output"])).toContain("hello; touch marker");
  });

  /**
   * @case (i) An editor with no terminal is refused clearly, not crashed into
   * @preconditions An editor advertising files but no terminal
   * @expectedResult The agent is told what is missing and no terminal call is
   *   attempted. A configuration mismatch should read as one rather than as
   *   a protocol error code nobody can act on.
   */
  test("i: an editor with no terminal gets a refusal naming what is missing", async () => {
    const run = await runCase(
      { command: "echo", args: ["hello"] },
      { capabilities: { fs: { readTextFile: true, writeTextFile: true } } },
    );

    expect(run.toolFailed).toBe(true);
    expect(run.modelSaw.toLowerCase()).toContain("terminal");
    expect(run.callsTo("terminal/create")).toHaveLength(0);
  });

  /**
   * @case (j) Listing and search, with ripgrep and without it
   * @preconditions A project with a file to find, run once normally and once
   *   with every ripgrep on PATH hidden
   * @expectedResult Both answer the same shape, and the fallback says which
   *   tool ran. The agent must not have to know which of the two is
   *   installed on the person's machine.
   */
  test("j: search returns paths and line numbers, with rg and with the git fallback", async () => {
    const withRipgrep = await runWithScriptedEditor({
      routes: [runCommand, listFiles, searchFiles],
      route: "search-files",
      input: { pattern: "needle" },
      seed: { "haystack.txt": "one\nneedle here\nthree\n" },
      capabilities: CAPABLE_EDITOR,
    });

    expect(withRipgrep.toolOutput?.["tool"]).toBe("rg");
    const matches = withRipgrep.toolOutput?.["matches"] as Array<
      Record<string, unknown>
    >;
    expect(matches[0]).toMatchObject({ path: "haystack.txt", line: 2 });
    expect(String(matches[0]?.["text"])).toContain("needle");
  });

  /**
   * @case (j) The git fallback answers the same shape
   * @preconditions The same project as a git repository, with ripgrep hidden
   *   from PATH so spawning it fails exactly as on a machine without it
   * @expectedResult `git grep` ran, and the matches carry the same path and
   *   line number the ripgrep run produced
   */
  test("j: with ripgrep absent, git grep answers the same shape", async () => {
    const run = await runWithScriptedEditor({
      routes: [runCommand, listFiles, searchFiles],
      route: "search-files",
      input: { pattern: "needle" },
      seed: { "haystack.txt": "one\nneedle here\nthree\n" },
      gitInit: true,
      absent: ["rg"],
    });

    expect(run.toolOutput?.["tool"]).toBe("git");
    const matches = run.toolOutput?.["matches"] as Array<
      Record<string, unknown>
    >;
    expect(matches[0]).toMatchObject({ path: "haystack.txt", line: 2 });
  });

  /**
   * @case The input schema cannot express a shell string
   * @preconditions The route's own schema
   * @expectedResult Arguments stay a list, and an absent list is empty rather
   *   than undefined, so the route never has to decide what absent means
   */
  test("the schema keeps arguments a list", () => {
    expect(
      RunCommandInput.parse({ command: "echo", args: ["a; b"] }).args,
    ).toEqual(["a; b"]);
    expect(RunCommandInput.parse({ command: "pwd" }).args).toEqual([]);
  });

  /**
   * @case The allowlist is configuration, not a literal in the route
   * @preconditions `RUN_COMMAND_ALLOWLIST` as `test/setup.ts` pins it
   * @expectedResult The parsed list, so an operator changes the boundary
   *   without touching a route
   */
  test("the allowlist comes from the environment", () => {
    expect(ALLOWLIST).toContain("git");
    expect(ALLOWLIST).not.toContain("curl");
  });

  /**
   * @case Reached without an editor at all, it refuses rather than crashing
   * @preconditions The route dispatched directly, as a schedule or
   *   `craft exec` would: no ACP surface on the exchange
   * @expectedResult A message naming what is missing, so reaching this
   *   capability from a cron does not produce a protocol error nobody can act
   *   on
   */
  test("refuses when there is no editor on the other end", async () => {
    t = await testContext().routes([runCommand]).build();
    await t.startAndWaitReady();

    const failure = await t.client
      .sendDirect("run-command", { command: "pwd", args: [] })
      .then(
        () => undefined,
        (error: Error) => error,
      );

    expect(failure?.message).toContain("does not offer");
  });
});
