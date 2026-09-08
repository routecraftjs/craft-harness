import { surface } from "@routecraft/ai";
import { craft, direct } from "@routecraft/routecraft";
import { z } from "zod";
import {
  FILE_CHARACTER_LIMIT,
  FILE_LINE_LIMIT,
  requireEditor,
} from "../../../shared/editor.js";
import { EditorPath } from "../../../shared/editor-paths.js";

/**
 * Read a file from the project the editor has open.
 *
 * The editor does the reading, which is the whole point: the file is on the
 * person's machine and this process is somewhere else. What this route adds
 * is the half of the boundary an editor will not enforce for you, and it
 * adds it in `.input()` so a refused path never becomes a protocol call.
 *
 * Two bounds, because the protocol offers one and it is not enough.
 * `ReadTextFileRequest` carries a `limit` in LINES, asked for up front so a
 * huge file is never serialised, sent and buffered here only to be refused.
 * A file of few but enormous lines passes that and is still caught by the
 * character cap, which is the one that decides how much of a turn a file may
 * take.
 *
 * One line more than the cap is requested, so a file at the boundary is
 * REFUSED rather than quietly returned short. A model handed 2000 lines of a
 * 40000 line file, with nothing saying so, reasons about the file it thinks
 * it read.
 */

export const ReadFileInput = z.object({
  path: EditorPath,
});
export type ReadFileInput = z.infer<typeof ReadFileInput>;

export default craft()
  .id("read-file")
  .description("Read a text file from the project open in the editor.")
  .input({ body: ReadFileInput })
  .from<ReadFileInput>(direct())
  .transform(async (input, exchange) => {
    requireEditor(exchange, "reading a file");

    const answer = await surface("fs/read_text_file", {
      path: input.path,
      limit: FILE_LINE_LIMIT + 1,
    }).fetch(exchange);

    if (answer.content.split("\n").length > FILE_LINE_LIMIT) {
      throw new Error(
        `${input.path} is longer than the ${FILE_LINE_LIMIT} lines this harness will pull into one turn. Search it instead, or read a smaller file.`,
      );
    }
    if (answer.content.length > FILE_CHARACTER_LIMIT) {
      throw new Error(
        `${input.path} is ${answer.content.length} characters, over the ${FILE_CHARACTER_LIMIT} this harness will pull into one turn. Search it instead, or read a smaller file.`,
      );
    }
    return { path: input.path, content: answer.content };
  });
