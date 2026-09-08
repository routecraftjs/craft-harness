import { craft, direct } from "@routecraft/routecraft";
import { z } from "zod";
import { SEARCH_MATCH_LIMIT, requireEditor } from "../../../shared/editor.js";
import {
  linesOf,
  withGitFallback,
} from "../../../shared/editor-terminal.js";

/**
 * Search the project the editor has open.
 *
 * The same shape as `list-files` and for the same reason: ACP has no search
 * method, the project is on the person's machine, and the editor's terminal
 * is the only thing that can read it. `rg -n` first, `git grep -n` when
 * ripgrep is absent, and both answer path, line number and text so the agent
 * never has to know which ran.
 *
 * The pattern is passed as its own argument and never spliced into a
 * command line, so a pattern containing a semicolon or a quote is a pattern.
 * `--` ends option parsing, so a pattern starting with a dash is a pattern
 * rather than a flag somebody did not intend to pass. Those two together are
 * why this needs no permission prompt: the model chooses the pattern and
 * nothing else.
 *
 * The trailing `.` is not decoration. Given no path, ripgrep reads standard
 * input, and whether the editor attached one is the editor's business; a
 * search that silently waits on a pipe nobody writes to arrives here as a
 * timeout. Naming the directory makes the command mean the same thing
 * whatever the terminal handed it.
 */

export const SearchFilesInput = z.object({
  pattern: z.string().min(1).describe("Regular expression to search for."),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(SEARCH_MATCH_LIMIT)
    .default(SEARCH_MATCH_LIMIT)
    .describe("Most matches to return."),
});
export type SearchFilesInput = z.infer<typeof SearchFilesInput>;

/** One match, in the shape both tools are normalised into. */
export interface Match {
  path: string;
  line: number;
  text: string;
}

/** What a search answers with, whichever tool produced it. */
export interface SearchResult {
  tool: "rg" | "git";
  matches: Match[];
  truncated: boolean;
}

/**
 * Parse `path:line:text`, which `rg -n` and `git grep -n` both emit.
 *
 * A line that does not carry both separators is kept as a match with no
 * line number rather than dropped: a binary-file notice or a warning is
 * something the agent should see rather than something this should hide.
 */
export function parseMatches(lines: string[]): Match[] {
  return lines.map((line) => {
    const match = /^(.*?):(\d+):(.*)$/.exec(line);
    if (match === null) return { path: "", line: 0, text: line };
    return {
      // `rg .` prefixes every path with `./` and `git grep` does not. The
      // promise these two make together is one shape, so the prefix is
      // dropped rather than left for the agent to notice it sometimes has
      // one and sometimes does not.
      path: match[1]!.replace(/^\.\//, ""),
      line: Number(match[2]),
      text: match[3]!,
    };
  });
}

export default craft()
  .id("search-files")
  .description(
    "Search the project open in the editor and return matching lines with their paths.",
  )
  .input({ body: SearchFilesInput })
  .from<SearchFilesInput>(direct())
  .transform(async (input, exchange, ctx): Promise<SearchResult> => {
    requireEditor(exchange, "searching the project");

    const { tool, result } = await withGitFallback(
      exchange,
      { command: "rg", args: ["-n", "--", input.pattern, "."] },
      { command: "git", args: ["grep", "-n", "--", input.pattern] },
      ctx?.signal,
    );

    // Both tools answer 1 for "no matches", which is not a failure.
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(`Could not search the project: ${result.output.trim()}`);
    }

    const { lines, truncated } = linesOf(result, input.limit);
    return {
      tool,
      matches: parseMatches(lines),
      truncated,
    };
  });
