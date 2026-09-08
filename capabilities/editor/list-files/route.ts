import { hasSurface } from "@routecraft/ai";
import { craft, direct } from "@routecraft/routecraft";
import { z } from "zod";
import { SEARCH_MATCH_LIMIT, editorCannot } from "../../../shared/editor.js";
import {
  type CommandResult,
  runInEditorTerminal,
} from "../run-command/route.js";

/**
 * List the files in the project the editor has open.
 *
 * ACP has no listing method, and it is not an oversight to work around: the
 * agent runs on one machine and the project is on the person's, so the only
 * thing that can enumerate it is the editor. That makes this a thin wrapper
 * over the terminal capability rather than a capability of its own, and it
 * is why it inherits that one's timeout, its output cap and its release.
 *
 * `rg --files` first because it honours `.gitignore` without being asked,
 * and `git ls-files` when ripgrep is not installed. Both answer the same
 * shape, so the agent does not have to know which one ran.
 *
 * The directory is named explicitly for the same reason it is in
 * `search-files`: without a path ripgrep reads standard input, and whether
 * the editor attached one is not this capability's to assume.
 */

/** Exit code a shell and this project's scripted editor both use for "not found". */
const NOT_FOUND = 127;

export const ListFilesInput = z.object({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(SEARCH_MATCH_LIMIT)
    .default(SEARCH_MATCH_LIMIT)
    .describe("Most paths to return."),
});
export type ListFilesInput = z.infer<typeof ListFilesInput>;

/** What a listing answers with, whichever tool produced it. */
export interface Listing {
  tool: "rg" | "git";
  paths: string[];
  truncated: boolean;
}

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

export default craft()
  .id("list-files")
  .description(
    "List the files in the project open in the editor, respecting .gitignore.",
  )
  .input({ body: ListFilesInput })
  .from<ListFilesInput>(direct())
  .transform(async (input, exchange, ctx): Promise<Listing> => {
    if (!hasSurface(exchange)) {
      throw new Error(
        editorCannot("a connection to your editor", "listing files"),
      );
    }

    const ripgrep = await runInEditorTerminal(
      exchange,
      { command: "rg", args: ["--files", "."] },
      ctx?.signal,
    );
    const usable = !missingProgram(ripgrep);
    const result = usable
      ? ripgrep
      : await runInEditorTerminal(
          exchange,
          { command: "git", args: ["ls-files"] },
          ctx?.signal,
        );

    if (result.exitCode !== 0) {
      throw new Error(
        `Could not list the project's files: ${result.output.trim()}`,
      );
    }

    const { lines, truncated } = linesOf(result, input.limit);
    return {
      tool: usable ? "rg" : "git",
      // Same normalisation as `search-files`: `rg .` prefixes `./` and
      // `git ls-files` does not.
      paths: lines.map((path) => path.replace(/^\.\//, "")),
      truncated,
    };
  });
