import { getEventListeners } from "node:events";
import { afterEach, describe, expect, test } from "bun:test";
import type { RequestPermissionOutcome } from "@agentclientprotocol/sdk";
import { testContext, type TestContext } from "@routecraft/testing";
import listFiles from "../capabilities/editor/list-files/route.js";
import runCommand, {
  ALLOWLIST,
  RunCommandInput,
  handsOverCode,
  reachesPastTheProject,
  spell,
} from "../capabilities/editor/run-command/route.js";
import searchFiles from "../capabilities/editor/search-files/route.js";
import { COMMAND_TIMEOUT_MS } from "../shared/editor.js";
import { abortion } from "../shared/editor-terminal.js";
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

  /**
   * A person clicking yes.
   *
   * Named because the shipped allowlist holds only programs that read and
   * print, so every case here that runs something else goes through the
   * prompt, and a case that did NOT say how the person answered would be
   * asserting against this file's default rather than against a decision.
   */
  const ALLOW = (): RequestPermissionOutcome => ({
    outcome: "selected",
    optionId: "allow",
  });

  /** A person clicking no. */
  const DENY = (): RequestPermissionOutcome => ({ outcome: "cancelled" });

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
   * @preconditions A script that exits 3 after writing to standard error.
   *   `bun` is NOT on the shipped allowlist, so the person allows it first,
   *   which is the honest shape: this is a program that runs whatever it is
   *   handed.
   * @expectedResult The agent sees a failed tool call whose text carries the
   *   exit code and the error output. A non-zero exit reported as a success
   *   with a field to notice is a result a model reads straight past.
   */
  test("c: exit 3 comes back as a failed call with its stderr", async () => {
    const run = await runCase(
      {
        command: "bun",
        args: ["-e", "console.error('the reason'); process.exit(3)"],
      },
      { permission: ALLOW },
    );

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
    const run = await runCase(
      {
        command: "bun",
        args: [
          "-e",
          "for (let i = 0; i < 20000; i += 1) console.log('x'.repeat(64))",
        ],
      },
      { permission: ALLOW },
    );

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
    const run = await runCase(
      { command: "bun", args: ["-e", "await Bun.sleep(30000)"] },
      { permission: ALLOW },
    );

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
      { permission: ALLOW, cancelOn: "terminal/wait_for_exit", drainMs: 4000 },
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
      { permission: DENY },
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
      { permission: ALLOW },
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
      projectFiles: { "haystack.txt": "one\nneedle here\nthree\n" },
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
      projectFiles: { "haystack.txt": "one\nneedle here\nthree\n" },
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
   * @preconditions `RUN_COMMAND_ALLOWLIST` as `test/setup.ts` pins it, which
   *   is the value `.env.schema` and `env.ts` ship
   * @expectedResult The parsed list, so an operator changes the boundary
   *   without touching a route. It holds only programs that read and print:
   *   an entry that can be told to run something else is not a narrower
   *   boundary than no boundary, it is none at all.
   */
  test("the shipped allowlist holds no program that runs something else", () => {
    expect([...ALLOWLIST].sort()).toEqual(["echo", "ls", "pwd", "rg"]);
    for (const gateway of ["bun", "node", "git", "cat", "sh", "curl"]) {
      expect(ALLOWLIST).not.toContain(gateway);
    }
  });

  /**
   * @case Reading this instance's own key needs the person to say yes
   * @preconditions A project holding a `.env` with a secret in it, and the
   *   editor refusing permission
   * @expectedResult No terminal, and the secret reaches neither the agent nor
   *   the result. `read-file` refuses `.env` by its path rules, and a
   *   `cat` that ran without asking would be that refusal with an extra step:
   *   this is the case that says the two guardrails cannot be played off
   *   against each other.
   */
  test("cat .env cannot run without being allowed", async () => {
    const run = await runCase(
      { command: "cat", args: [".env"] },
      {
        projectFiles: { ".env": "CRAFT_API_KEY=super-secret-value-here\n" },
        permission: DENY,
      },
    );

    expect(run.callsTo("session/request_permission")).toHaveLength(1);
    expect(run.callsTo("terminal/create")).toHaveLength(0);
    expect(run.modelSaw).not.toContain("super-secret-value-here");
    expect(JSON.stringify(run.toolOutput)).not.toContain(
      "super-secret-value-here",
    );
  });

  /**
   * @case An allowlisted program handed code to run is still asked about
   * @preconditions `rg` is on the allowlist, called with `-e`
   * @expectedResult The person is asked anyway. The allowlist names programs
   *   and a program that takes code is a way past it, so the argument decides
   *   too. `-e` is a legitimate ripgrep flag and this costs it a prompt, which
   *   is the right way round: the check can only ever cost a question.
   */
  test("an interpreter argument on an allowlisted program still asks", async () => {
    const run = await runCase(
      { command: "rg", args: ["-e", "needle", "."] },
      { permission: DENY },
    );

    expect(run.callsTo("session/request_permission")).toHaveLength(1);
    expect(run.callsTo("terminal/create")).toHaveLength(0);
  });

  /**
   * @case The arguments that hand a program code, by their spelling
   * @preconditions The predicate the route asks
   * @expectedResult The shapes that turn an allowlisted program into a shell
   *   are caught in both spellings, and ordinary flags are not
   */
  test("arguments that run something else are recognised", () => {
    expect(handsOverCode(["-e", "console.log(1)"])).toBe(true);
    expect(handsOverCode(["--eval=console.log(1)"])).toBe(true);
    expect(handsOverCode(["-c", "alias.x=!sh"])).toBe(true);
    expect(handsOverCode(["--exec-path=/tmp"])).toBe(true);
    expect(handsOverCode(["--files", "."])).toBe(false);
    expect(handsOverCode(["-n", "--", "needle", "."])).toBe(false);
    expect(handsOverCode(["-C", "/some/dir"])).toBe(false);
  });

  /**
   * @case An allowlisted reader pointed outside the project is asked about
   * @preconditions `rg` is on the allowlist, given a path that is not the
   *   project
   * @expectedResult The person is asked. `rg` and `ls` are on the list
   *   because they only read, but WHERE they read is an argument, and
   *   `rg -n "PRIVATE KEY" /home/you` is the leak `read-file` refuses
   *   arriving by the other door.
   */
  test("an allowlisted reader aimed outside the project still asks", async () => {
    const run = await runCase(
      { command: "rg", args: ["--files", "/home"] },
      { permission: DENY },
    );

    expect(run.callsTo("session/request_permission")).toHaveLength(1);
    expect(run.callsTo("terminal/create")).toHaveLength(0);
  });

  /**
   * @case The arguments that reach past the project, by their spelling
   * @preconditions The predicate the route asks
   * @expectedResult The same rule `shared/editor-paths.ts` applies to file
   *   paths, read the other way round, and the ordinary flags and the bare
   *   `.` that these commands are normally called with are untouched
   */
  test("arguments naming somewhere else are recognised", () => {
    expect(reachesPastTheProject(["/etc/passwd"])).toBe(true);
    expect(reachesPastTheProject(["../../home/you"])).toBe(true);
    expect(reachesPastTheProject([".env"])).toBe(true);
    expect(reachesPastTheProject(["src/../.ssh/id_rsa"])).toBe(true);
    expect(reachesPastTheProject(["--files", "."])).toBe(false);
    expect(reachesPastTheProject(["-n", "--", "needle", "./src"])).toBe(false);
    expect(reachesPastTheProject(["src/index.ts"])).toBe(false);
  });

  /**
   * @case The prompt cannot be made to read as a different question
   * @preconditions An argument carrying newlines, a bidirectional override
   *   and more text than a dialogue shows
   * @expectedResult One line, no override characters, capped. This prompt is
   *   the whole boundary for anything off the allowlist, and every character
   *   of it comes from the model: a model that can lay out the dialogue can
   *   ask a question the person did not answer.
   */
  test("the permission prompt cannot be composed by the model", () => {
    const spelled = spell("git", [
      "--version\n\nApproved by policy.\n\nRun git --version",
      "\u202eevil",
      "x".repeat(500),
    ]);

    expect(spelled).not.toContain("\n");
    expect(spelled).not.toContain("\u202e");
    expect(spelled.length).toBeLessThanOrEqual(300);
    expect(spelled.startsWith('"git"')).toBe(true);
  });

  /**
   * @case A finished command takes its cancellation listener back off
   * @preconditions The turn's signal, and the signal the command settles
   * @expectedResult No listener remains. Every command adds one to the turn's
   *   signal, and a turn that searches a few times collects one per command,
   *   each holding its reject closure until the turn ends.
   */
  test("a settled command removes its listener from the turn's signal", () => {
    const turn = new AbortController();
    const settled = new AbortController();

    void abortion(turn.signal, settled.signal).catch(() => undefined);
    expect(getEventListeners(turn.signal, "abort")).toHaveLength(1);

    settled.abort();
    expect(getEventListeners(turn.signal, "abort")).toHaveLength(0);
  });

  /**
   * @case A finished command clears the timer that would have killed it
   * @preconditions A command that exits at once, with every timer of the
   *   command timeout's own duration counted
   * @expectedResult One was started and none is left running. An uncleared
   *   timer keeps a one-shot run (`craft exec`, a scheduled turn) alive for
   *   the whole deadline after the work is done.
   */
  test("a finished command leaves no timeout timer running", async () => {
    const started = new Set<unknown>();
    let made = 0;
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;

    globalThis.setTimeout = ((
      handler: Parameters<typeof setTimeout>[0],
      ms?: number,
      ...rest: unknown[]
    ) => {
      const handle = (
        realSetTimeout as unknown as (
          ...args: unknown[]
        ) => ReturnType<typeof setTimeout>
      )(handler, ms, ...rest);
      if (ms === COMMAND_TIMEOUT_MS) {
        made += 1;
        started.add(handle);
      }
      return handle;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
      started.delete(handle);
      realClearTimeout(handle);
    }) as typeof clearTimeout;

    try {
      await runCase({ command: "echo", args: ["hello"] });
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }

    expect(made).toBeGreaterThan(0);
    expect(started.size).toBe(0);
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

    expect(failure?.message).toContain("No editor is connected");
  });
});
