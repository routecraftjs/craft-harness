import { hasSurface, surface } from "@routecraft/ai";
import { type Exchange, craft, direct } from "@routecraft/routecraft";
import { z } from "zod";
import {
  COMMAND_TIMEOUT_MS,
  OUTPUT_BYTE_LIMIT,
  editorCannot,
} from "../../../shared/editor.js";
import { env } from "../../../env.js";

/**
 * Run a command in the person's own editor terminal.
 *
 * This is not `bash-runner` with a different transport. `bash-runner` puts a
 * script inside a kernel isolation tier and lets it say anything, because
 * the tier is the boundary. Here there is no tier: the command runs in the
 * editor, as the person, with their files and their network. So the
 * boundary has to be the other one available, which is what may be run at
 * all, and that is a list an operator can read.
 *
 * Four guardrails, all enforced in this file:
 *
 * - **An allowlist**, from `RUN_COMMAND_ALLOWLIST`. Anything not on it asks
 *   the person first, through the editor, and runs only if they say yes.
 * - **Arguments as a list**, never a string this route joins. `terminal/create`
 *   takes `command` and `args` separately and the editor spawns without a
 *   shell, so `hello; touch marker` passed as one argument is one argument.
 *   There is no spelling of this input that reaches a shell metacharacter.
 * - **A timeout**, after which the terminal is killed and the call reports
 *   that it timed out rather than hanging the turn.
 * - **Bounded output**, by asking the editor to retain at most
 *   `OUTPUT_BYTE_LIMIT` and reporting when it truncated.
 *
 * The terminal is always released, on every path: success, failure, timeout
 * and cancellation. A terminal the editor holds open is a resource in
 * somebody's IDE that nothing in this process will ever close again.
 *
 * ACP has no "run and give me the output" call. This is the composition of
 * five: create, wait, output, kill where needed, release. That is why the
 * body is one `.transform()` rather than a chain of `.enrich()` steps: the
 * lifecycle has a cleanup path, and a pipeline of enrichers cannot express
 * "whatever happened above, release the terminal".
 */

/** Commands that need no permission, parsed once from the environment. */
export const ALLOWLIST: readonly string[] = env.RUN_COMMAND_ALLOWLIST;

export const RunCommandInput = z.object({
  command: z
    .string()
    .min(1)
    .describe("Program to run, e.g. git. Not a shell line."),
  args: z
    .array(z.string())
    .default([])
    .describe(
      "Arguments, one per element. They are passed as a list and never joined, so shell syntax in an argument is literal text.",
    ),
});
export type RunCommandInput = z.infer<typeof RunCommandInput>;

/** What the capability answers with: a finished command, or a refusal. */
export type CommandOutcome =
  CommandResult | { command: string; args: string[]; refused: string };

/** What a finished command answers with. */
export interface CommandResult {
  command: string;
  args: string[];
  exitCode: number | null;
  output: string;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * Run one command through the editor and answer with its result.
 *
 * Exported because `list-files` and `search-files` are this capability with
 * a fixed command, and reimplementing the lifecycle in each of them is how
 * one of the three would end up not releasing its terminal.
 */
export async function runInEditorTerminal(
  exchange: Exchange<unknown>,
  input: RunCommandInput,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const created = (await surface("terminal/create", {
    command: input.command,
    // `cwd` is deliberately omitted. The editor runs a terminal in the
    // directory it opened the conversation in, which is the project the
    // person is looking at, and this process runs somewhere else entirely.
    // Naming a directory here would be this instance guessing at theirs.
    args: input.args,
    outputByteLimit: OUTPUT_BYTE_LIMIT,
  }).fetch(exchange)) as { terminalId: string };

  const terminalId = created.terminalId;
  let timedOut = false;
  try {
    const exit = await Promise.race([
      Promise.resolve(
        surface("terminal/wait_for_exit", { terminalId }).fetch(exchange),
      ),
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), COMMAND_TIMEOUT_MS),
      ),
      abortion(signal),
    ]);

    if (exit === undefined) {
      timedOut = true;
      await surface("terminal/kill", { terminalId }).fetch(exchange);
    }

    const read = (await surface("terminal/output", { terminalId }).fetch(
      exchange,
    )) as { output: string; truncated: boolean };

    return {
      command: input.command,
      args: input.args,
      exitCode: timedOut ? null : (exit?.exitCode ?? null),
      output: read.output,
      truncated: read.truncated,
      timedOut,
    };
  } catch (error: unknown) {
    // A cancelled turn still owns the child process it started. Kill it
    // before letting the cancellation continue, or the person is left with
    // something running in their terminal that nobody is waiting for.
    await Promise.resolve(
      surface("terminal/kill", { terminalId }).fetch(exchange),
    ).catch(() => undefined);
    throw error;
  } finally {
    // The one call that must happen on every path.
    await Promise.resolve(
      surface("terminal/release", { terminalId }).fetch(exchange),
    ).catch(() => undefined);
  }
}

/** A promise that rejects when the turn is cancelled, or never settles. */
function abortion(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) {
      reject(new Error("The turn was cancelled."));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new Error("The turn was cancelled.")),
      { once: true },
    );
  });
}

/**
 * Ask the person before running something the allowlist does not cover.
 *
 * Composed rather than assumed: a refusal and a malformed answer both reach
 * here as the protocol's `cancelled` outcome, which is what makes the
 * default deny rather than allow.
 */
export async function permitted(
  exchange: Exchange<unknown>,
  input: RunCommandInput,
): Promise<boolean> {
  if (ALLOWLIST.includes(input.command)) return true;

  const spelled = [input.command, ...input.args].join(" ");
  const answer = (await surface("session/request_permission", {
    toolCall: {
      toolCallId: `run-command-${Date.now()}`,
      title: `Run ${spelled}`,
      kind: "execute",
    },
    options: [
      { optionId: "allow", name: `Run ${spelled}`, kind: "allow_once" },
      { optionId: "deny", name: "Do not run it", kind: "reject_once" },
    ],
  }).fetch(exchange)) as {
    outcome: { outcome: string; optionId?: string };
  };

  return (
    answer.outcome.outcome === "selected" && answer.outcome.optionId === "allow"
  );
}

export default craft()
  .id("run-command")
  .description(
    "Run a command in the editor's terminal and return its output. Arguments are a list, not a shell line.",
  )
  .input({ body: RunCommandInput })
  .from<RunCommandInput>(direct())
  .transform(async (input, exchange, ctx): Promise<CommandOutcome> => {
    if (!hasSurface(exchange)) {
      throw new Error(
        editorCannot("a connection to your editor", "running a command"),
      );
    }

    if (!(await permitted(exchange, input))) {
      return {
        command: input.command,
        args: input.args,
        refused: "You did not allow this command, so nothing was run.",
      };
    }

    const result = await runInEditorTerminal(exchange, input, ctx?.signal);

    if (result.timedOut) {
      throw new Error(
        `\`${input.command}\` ran longer than ${COMMAND_TIMEOUT_MS / 1000}s and was killed. Output so far:\n${result.output}`,
      );
    }
    if (result.exitCode !== 0) {
      // A non-zero exit is a failed tool call rather than a result the model
      // has to notice a field on. The output rides along, because the reason
      // is almost always in it.
      throw new Error(
        `\`${input.command}\` exited ${result.exitCode}.\n${result.output}`,
      );
    }
    return result;
  });
