import { hasSurface, surface } from "@routecraft/ai";
import { craft, direct } from "@routecraft/routecraft";
import { z } from "zod";
import { FILE_CHARACTER_LIMIT, editorCannot } from "../../../shared/editor.js";
import { pathRefusal } from "../../../shared/editor-paths.js";

/**
 * Read a file from the project the editor has open.
 *
 * The editor does the reading, which is the whole point: the file is on the
 * person's machine and this process is somewhere else. What this route adds
 * is the half of the boundary an editor will not enforce for you, and it
 * adds it in `.input()` so a refused path never becomes a protocol call.
 *
 * The size cap is applied to what comes back rather than asked for up front:
 * the protocol has no "read at most n" and a route that pretended otherwise
 * would be describing a limit it does not have. What it does have is a
 * refusal to put a whole large file into a turn.
 */

export const ReadFileInput = z.object({
  path: z
    .string()
    .min(1)
    .refine((value) => pathRefusal(value) === undefined, {
      error: (issue) => pathRefusal(String(issue.input)) ?? "Refused.",
    })
    .describe("Absolute path to the file, inside the open project."),
});
export type ReadFileInput = z.infer<typeof ReadFileInput>;

export default craft()
  .id("read-file")
  .description("Read a text file from the project open in the editor.")
  .input({ body: ReadFileInput })
  .from<ReadFileInput>(direct())
  .transform(async (input, exchange) => {
    if (!hasSurface(exchange)) {
      throw new Error(
        editorCannot("a connection to your editor", "reading a file"),
      );
    }

    const answer = (await surface("fs/read_text_file", {
      path: input.path,
    }).fetch(exchange)) as { content: string };

    if (answer.content.length > FILE_CHARACTER_LIMIT) {
      throw new Error(
        `${input.path} is ${answer.content.length} characters, over the ${FILE_CHARACTER_LIMIT} this harness will pull into one turn. Search it instead, or read a smaller file.`,
      );
    }
    return { path: input.path, content: answer.content };
  });
