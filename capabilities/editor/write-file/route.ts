import { surface } from "@routecraft/ai";
import { craft, direct } from "@routecraft/routecraft";
import { z } from "zod";
import { FILE_CHARACTER_LIMIT, requireEditor } from "../../../shared/editor.js";
import { EditorPath } from "../../../shared/editor-paths.js";
import { askPermission } from "../ask-permission/route.js";

/**
 * Write a file in the project the editor has open.
 *
 * Every write asks first. There is no allowlist here of the kind
 * `run-command` has, because there is no set of files it is obviously fine
 * to overwrite without saying so: the person is looking at this project, and
 * a file changing under them is exactly the thing they would want to have
 * agreed to.
 *
 * The same path rules as reading, for the same reasons, plus a cap on what
 * may be written in one call.
 */

export const WriteFileInput = z.object({
  path: EditorPath,
  content: z
    .string()
    .max(FILE_CHARACTER_LIMIT)
    .describe("The file's whole new content."),
});
export type WriteFileInput = z.infer<typeof WriteFileInput>;

export default craft()
  .id("write-file")
  .description(
    "Write a text file in the project open in the editor, after asking.",
  )
  .input({ body: WriteFileInput })
  .from<WriteFileInput>(direct())
  .transform(async (input, exchange) => {
    requireEditor(exchange, "writing a file");

    const allowed = await askPermission(exchange, {
      title: `Write ${input.path}`,
      kind: "edit",
    });
    if (!allowed) {
      return {
        path: input.path,
        refused: "You did not allow this write, so the file is unchanged.",
      };
    }

    await surface("fs/write_text_file", {
      path: input.path,
      content: input.content,
    }).fetch(exchange);

    return { path: input.path, written: input.content.length };
  });
