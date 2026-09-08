import { surface } from "@routecraft/ai";
import { craft, direct } from "@routecraft/routecraft";
import { z } from "zod";
import { FILE_CHARACTER_LIMIT, requireEditor } from "../../../shared/editor.js";
import { EditorPath } from "../../../shared/editor-paths.js";
import { askPermission } from "../ask-permission/route.js";

/**
 * Replace a piece of text in a file, and show the person the change.
 *
 * ACP has no edit primitive. This is the composition of the three calls it
 * does have: read the file, apply the replacement here, write it back. The
 * fourth thing it does is the reason the capability exists rather than the
 * model being told to read and write itself: the change is carried as a DIFF
 * on the permission request, so JetBrains renders it as a diff the person
 * looks at while they answer instead of a wall of new file content.
 *
 * The diff rides ON the request rather than being pushed as a separate
 * update. A `tool_call_update` would have to name a tool call id, and this
 * route cannot reach the one the adapter assigned; a client that is handed an
 * id it has never seen is free to drop the update, which would leave the
 * person answering "apply the change" having been shown nothing.
 *
 * `find` must appear exactly once. A replacement that matched twice would
 * change something the model did not look at, and one that matched nothing
 * is a model working from a stale read; both are refusals rather than a
 * best effort.
 *
 * ## The file is read twice
 *
 * The write is a whole-file replacement built from a read taken before the
 * person was asked, and the gap between the two is however long they spend
 * looking at the diff. They are, by construction, sitting in the editor with
 * this file open. So the file is read again after they answer, and a change
 * in between is refused rather than reverted: typing, a formatter on save, or
 * a checkout in another pane would otherwise be silently undone by a click
 * that meant something else.
 *
 * Unlike `read-file` this cannot ask the editor for a line limit, because it
 * writes the whole file back and a partial read would truncate it.
 */

export const EditFileInput = z.object({
  path: EditorPath,
  find: z
    .string()
    .min(1)
    .describe("Exact text to replace. Must appear exactly once in the file."),
  replace: z.string().describe("What to put in its place."),
});
export type EditFileInput = z.infer<typeof EditFileInput>;

/** Where `find` sits in `text`, or why it cannot be replaced. */
export function locate(
  text: string,
  find: string,
): { at: number } | { refusal: string } {
  const first = text.indexOf(find);
  if (first === -1) {
    return {
      refusal:
        "That text is not in the file. Read it again: it may have changed since you last saw it.",
    };
  }
  if (text.indexOf(find, first + find.length) !== -1) {
    return {
      refusal:
        "That text appears more than once, so replacing it would change something you have not looked at. Include enough surrounding text to make it unique.",
    };
  }
  return { at: first };
}

export default craft()
  .id("edit-file")
  .description(
    "Replace an exact piece of text in a file in the editor's project, showing the change as a diff.",
  )
  .input({ body: EditFileInput })
  .from<EditFileInput>(direct())
  .transform(async (input, exchange) => {
    requireEditor(exchange, "editing a file");

    const before = await surface("fs/read_text_file", {
      path: input.path,
    }).fetch(exchange);

    const found = locate(before.content, input.find);
    if ("refusal" in found) throw new Error(found.refusal);

    const after =
      before.content.slice(0, found.at) +
      input.replace +
      before.content.slice(found.at + input.find.length);

    if (after.length > FILE_CHARACTER_LIMIT) {
      throw new Error(
        `That edit would make ${input.path} ${after.length} characters, over the ${FILE_CHARACTER_LIMIT} this harness will write in one call.`,
      );
    }

    const allowed = await askPermission(
      exchange,
      { title: `Apply the change to ${input.path}`, kind: "edit" },
      [
        {
          type: "diff",
          path: input.path,
          oldText: before.content,
          newText: after,
        },
      ],
    );
    if (!allowed) {
      return {
        path: input.path,
        refused: "You did not allow this change, so the file is unchanged.",
      };
    }

    const current = await surface("fs/read_text_file", {
      path: input.path,
    }).fetch(exchange);
    if (current.content !== before.content) {
      throw new Error(
        `${input.path} changed while you were being asked, so this edit was not applied: it would have reverted that change. Read the file again and edit from what is there now.`,
      );
    }

    await surface("fs/write_text_file", {
      path: input.path,
      content: after,
    }).fetch(exchange);

    return { path: input.path, replaced: input.find.length };
  });
