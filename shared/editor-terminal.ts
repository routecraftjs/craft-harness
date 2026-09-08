import { surface } from "@routecraft/ai";
import type { Exchange } from "@routecraft/routecraft";
import { COMMAND_TIMEOUT_MS, OUTPUT_BYTE_LIMIT } from "./editor.js";

/**
 * The editor terminal's lifecycle, once, for the three capabilities that use
 * it.
 *
 * ACP has no "run and give me the output" call. A command is the composition
 * of five: create, wait, output, kill where needed, release. Three
 * capabilities need that composition (`run-command`, `list-files`,
 * `search-files`), and a copy in each is how one of the three ends up not
 * releasing its terminal. A terminal the editor holds open is a resource in
 * somebody's IDE that nothing in this process will ever close again.
 *
 * Two of the four `run-command` guardrails are here, because they are
 * properties of the lifecycle rather than of any one capability: the timeout
 * that kills a command and reports it, and the output cap the editor is asked
 * to apply. The other two, the allowlist and arguments-as-a-list, stay in
 * `run-command` where they decide what that capability may do.
 */

/** A program and its arguments, never a shell line. */
export interface TerminalCommand {
  command: string;
  args: string[];
}

/** What a finished command answers with. */
export interface CommandResult {
  command: string;
  args: string[];
  exitCode: number | null;
  output: string;
  truncated: boolean;
  timedOut: boolean;
}

/** Exit code a shell and this project's scripted editor both use for "not found". */
const NOT_FOUND = 127;

/** Whether a result means the program is not installed rather than failed. */
export function missingProgram(result: CommandResult): boolean {
  return result.exitCode === NOT_FOUND;
}

/** Lines of a command's output, blank ones dropped, cut to a limit. */
export function linesOf(
  result: CommandResult,
  limit: number,
): { lines: string[]; truncated: boolean } {
  const all = result.output.split("\n").filter((line) => line.trim() !== "");
  return {
    lines: all.slice(0, limit),
    truncated: result.truncated || all.length > limit,
  };
}

/** Run one command through the editor and answer with its result. */
export async function runInEditorTerminal(
  exchange: Exchange<unknown>,
  input: TerminalCommand,
  signal?: AbortSignal,
): Promise<CommandResult> {
  // `cwd` is omitted: the editor runs its terminal in the project it opened
  // the conversation in, and naming a directory would be this process
  // guessing at somebody else's filesystem.
  const created = await surface("terminal/create", {
    command: input.command,
    args: input.args,
    outputByteLimit: OUTPUT_BYTE_LIMIT,
  }).fetch(exchange);

  const terminalId = created.terminalId;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Aborted in `finally` to take the timeout's abort listener back off the
  // turn's signal. A listener left behind holds its reject closure for the
  // life of the turn, and a turn that runs a handful of searches collects one
  // per command.
  const settled = new AbortController();

  try {
    const exit = await Promise.race([
      Promise.resolve(
        surface("terminal/wait_for_exit", { terminalId }).fetch(exchange),
      ),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), COMMAND_TIMEOUT_MS);
      }),
      abortion(signal, settled.signal),
    ]);

    if (exit === undefined) {
      timedOut = true;
      // A kill that fails must not replace "it timed out" with a protocol
      // error, or the model is told the wrong thing and loses the output.
      await Promise.resolve(
        surface("terminal/kill", { terminalId }).fetch(exchange),
      ).catch(() => undefined);
    }

    const read = await surface("terminal/output", { terminalId }).fetch(
      exchange,
    );

    return {
      command: input.command,
      args: input.args,
      exitCode: timedOut ? null : (exit?.exitCode ?? null),
      output: read.output,
      truncated: read.truncated ?? false,
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
    if (timer !== undefined) clearTimeout(timer);
    settled.abort();
    // The one call that must happen on every path.
    await Promise.resolve(
      surface("terminal/release", { terminalId }).fetch(exchange),
    ).catch(() => undefined);
  }
}

/**
 * Run the ripgrep form, or the git form when ripgrep is not installed.
 *
 * `list-files` and `search-files` make the same promise to the agent, that
 * both answer one shape so it never has to know which ran. That promise is
 * one decision about when ripgrep counts as absent, and it is kept in one
 * place here rather than in two copies that can drift apart.
 */
export async function withGitFallback(
  exchange: Exchange<unknown>,
  ripgrep: TerminalCommand,
  git: TerminalCommand,
  signal?: AbortSignal,
): Promise<{ tool: "rg" | "git"; result: CommandResult }> {
  const first = await runInEditorTerminal(exchange, ripgrep, signal);
  if (!missingProgram(first)) return { tool: "rg", result: first };
  return {
    tool: "git",
    result: await runInEditorTerminal(exchange, git, signal),
  };
}

/**
 * A promise that rejects when the turn is cancelled, or never settles.
 *
 * `settled` takes the listener back off when the command finishes, which is
 * the common case: without it every command leaves one on the turn's signal,
 * holding its reject closure for the life of the turn.
 *
 * Exported for the test that asserts exactly that, because the removal is
 * invisible from outside: a leak shows up as a warning after ten commands
 * rather than as a failure.
 */
export function abortion(
  signal: AbortSignal | undefined,
  settled: AbortSignal,
): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) {
      reject(new Error("The turn was cancelled."));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new Error("The turn was cancelled.")),
      { once: true, signal: settled },
    );
  });
}
