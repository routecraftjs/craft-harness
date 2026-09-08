import { craft, direct } from "@routecraft/routecraft";
import { z } from "zod";
import { SEARCH_MATCH_LIMIT, requireEditor } from "../../../shared/editor.js";
import { linesOf, withGitFallback } from "../../../shared/editor-terminal.js";

/**
 * List the files in the project the editor has open.
 *
 * ACP has no listing method, and it is not an oversight to work around: the
 * agent runs on one machine and the project is on the person's, so the only
 * thing that can enumerate it is the editor. That makes this a thin wrapper
 * over the editor terminal rather than a capability of its own, and it is why
 * it inherits that lifecycle's timeout, its output cap and its release.
 *
 * `rg --files` first because it honours `.gitignore` without being asked,
 * and `git ls-files` when ripgrep is not installed. Both answer the same
 * shape, so the agent does not have to know which one ran.
 *
 * Neither command goes through `run-command`'s allowlist, and that is the
 * point rather than a hole: the two programs and all of their arguments are
 * written here, so there is nothing for a model to choose.
 *
 * The directory is named explicitly for the same reason it is in
 * `search-files`: without a path ripgrep reads standard input, and whether
 * the editor attached one is not this capability's to assume.
 */

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

export default craft()
  .id("list-files")
  .description(
    "List the files in the project open in the editor, respecting .gitignore.",
  )
  .input({ body: ListFilesInput })
  .from<ListFilesInput>(direct())
  .transform(async (input, exchange, ctx): Promise<Listing> => {
    requireEditor(exchange, "listing files");

    const { tool, result } = await withGitFallback(
      exchange,
      { command: "rg", args: ["--files", "."] },
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
      tool,
      // Same normalisation as `search-files`: `rg .` prefixes `./` and
      // `git ls-files` does not.
      paths: lines.map((path) => path.replace(/^\.\//, "")),
      truncated,
    };
  });
