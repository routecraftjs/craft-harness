import { type Exchange, craft, direct } from "@routecraft/routecraft";
import { z } from "zod";
import {
  COMMAND_TIMEOUT_MS,
  readable,
  requireEditor,
} from "../../../shared/editor.js";
import {
  type CommandResult,
  runInEditorTerminal,
} from "../../../shared/editor-terminal.js";
import { askPermission } from "../ask-permission/route.js";
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
 * Four guardrails. Two are here, because they decide what this capability
 * may do:
 *
 * - **An allowlist**, from `RUN_COMMAND_ALLOWLIST`. Anything not on it asks
 *   the person first, through the editor, and runs only if they say yes.
 * - **Arguments as a list**, never a string this route joins. `terminal/create`
 *   takes `command` and `args` separately and the editor spawns without a
 *   shell, so `hello; touch marker` passed as one argument is one argument.
 *   There is no spelling of this input that reaches a shell metacharacter.
 *
 * The other two, a timeout and a bounded output, are properties of the
 * terminal lifecycle and live in `shared/editor-terminal.ts` with it, because
 * `list-files` and `search-files` need the same lifecycle and a copy each is
 * how one of the three ends up not releasing its terminal.
 *
 * ## What the allowlist is worth
 *
 * It is an allowlist of PROGRAMS, and a program that can be told to run
 * something else makes it worthless. `bun -e`, `git -c alias.x=!sh` and `cat`
 * on a file of credentials are each the whole boundary gone, quietly, with no
 * prompt. So the shipped default carries only programs that read and print,
 * and two argument checks below take the quiet path away from a call that
 * hands a program code to run, or that points a reading program at something
 * outside the project. Those are guards against an operator's mistake rather
 * than boundaries of their own: a list containing an interpreter is unsafe
 * whatever this file does about its flags.
 */

/** Commands that need no permission, parsed once from the environment. */
export const ALLOWLIST: readonly string[] = env.RUN_COMMAND_ALLOWLIST;

/**
 * Arguments that turn a program into a way of running something else.
 *
 * Matched on the argument's own spelling, both `-e code` and `--eval=code`.
 * Not exhaustive and not meant to be: it costs a prompt, never a failure, so
 * a spelling it misses is a program that should not have been allowlisted.
 */
const HANDS_OVER_CODE =
  /^--?(e|eval|c|command|exec|exec-path|p|print|upload-pack|receive-pack|config)(=|$)/;

/** Whether any of these arguments is the kind that runs something else. */
export function handsOverCode(args: string[]): boolean {
  return args.some((arg) => HANDS_OVER_CODE.test(arg));
}

/**
 * Whether an argument names something the file capabilities would refuse.
 *
 * `rg` and `ls` only read, which is why they can run without asking, but
 * WHERE they read is an argument. `rg -n "PRIVATE KEY" /home/you` and
 * `ls .ssh` are the leak `read-file` exists to refuse, arriving by the other
 * door. The rule is the one in `shared/editor-paths.ts` read the other way
 * round: absolute, up, or hidden means ask. A bare `.` is the project itself
 * and is how these commands are normally called.
 *
 * A search pattern that happens to look like a path costs a prompt. That is
 * the right way for this to be wrong.
 */
export function reachesPastTheProject(args: string[]): boolean {
  return args.some((arg) => {
    if (arg.startsWith("/")) return true;
    return arg
      .split("/")
      .some((segment) => segment.startsWith(".") && segment !== ".");
  });
}

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

/**
 * The command as the person will read it in the permission prompt.
 *
 * Quoted per argument rather than joined with spaces, so `["a b"]` and
 * `["a", "b"]` do not read identically: the boundaries are the whole point of
 * taking a list, and the prompt is where they matter most.
 */
export function spell(command: string, args: string[]): string {
  return readable(
    [command, ...args].map((part) => JSON.stringify(part)).join(" "),
  );
}

/**
 * Ask the person before running something the allowlist does not cover.
 *
 * Composed rather than assumed: a refusal and a malformed answer both reach
 * `askPermission` as the protocol's `cancelled` outcome, which is what makes
 * the default deny rather than allow.
 */
export async function permitted(
  exchange: Exchange<unknown>,
  input: RunCommandInput,
): Promise<boolean> {
  const quiet =
    ALLOWLIST.includes(input.command) &&
    !handsOverCode(input.args) &&
    !reachesPastTheProject(input.args);
  if (quiet) return true;

  return askPermission(exchange, {
    title: `Run ${spell(input.command, input.args)}`,
    kind: "execute",
  });
}

export default craft()
  .id("run-command")
  .description(
    "Run a command in the editor's terminal and return its output. Arguments are a list, not a shell line.",
  )
  .input({ body: RunCommandInput })
  .from<RunCommandInput>(direct())
  .transform(async (input, exchange, ctx): Promise<CommandOutcome> => {
    requireEditor(exchange, "running a command");

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
