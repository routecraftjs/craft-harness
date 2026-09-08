import { hasSurface, surface } from "@routecraft/ai";
import { craft, direct } from "@routecraft/routecraft";
import { z } from "zod";
import { FILE_CHARACTER_LIMIT, editorCannot } from "../../../shared/editor.js";
import { pathRefusal } from "../../../shared/editor-paths.js";
import { askPermission } from "../ask-permission/route.js";

/**
 * Replace a piece of text in a file, and show the person the change.
 *
 * ACP has no edit primitive. This is the composition of the three calls it
 * does have: read the file, apply the replacement here, write it back. The
 * fourth thing it does is the reason the capability exists rather than the
 * model being told to read and write itself: the change is reported to the
 * editor as a DIFF on the tool call, so JetBrains renders it as a diff the
 * person can look at instead of a wall of new file content.
 *
 * The diff is pushed before the write, not after. A person who is about to
 * be asked whether to allow a change should be looking at the change while
 * they answer.
 *
 * `find` must appear exactly once. A replacement that matched twice would
 * change something the model did not look at, and one that matched nothing
 * is a model working from a stale read; both are refusals rather than a
 * best effort.
 */

export const EditFileInput = z.object({
  path: z
    .string()
    .min(1)
    .refine((value) => pathRefusal(value) === undefined, {
      error: (issue) => pathRefusal(String(issue.input)) ?? "Refused.",
    })
    .describe("Absolute path to the file, inside the open project."),
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
    if (!hasSurface(exchange)) {
      throw new Error(
        editorCannot("a connection to your editor", "editing a file"),
      );
    }

    const before = (await surface("fs/read_text_file", {
      path: input.path,
    }).fetch(exchange)) as { content: string };

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

    // The diff, before the question, so the person answers while looking at
    // the change rather than at its description.
    await surface
      .notify(() => ({
        sessionUpdate: "tool_call_update" as const,
        toolCallId: `edit-${input.path}`,
        content: [
          {
            type: "diff" as const,
            path: input.path,
            oldText: before.content,
            newText: after,
          },
        ],
      }))
      .send(exchange);

    const allowed = await askPermission(exchange, {
      title: `Apply the change to ${input.path}`,
      kind: "edit",
    });
    if (!allowed) {
      return {
        path: input.path,
        refused: "You did not allow this change, so the file is unchanged.",
      };
    }

    await surface("fs/write_text_file", {
      path: input.path,
      content: after,
    }).fetch(exchange);

    return { path: input.path, replaced: input.find.length };
  });
