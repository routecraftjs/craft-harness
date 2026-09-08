import { z } from "zod";

/**
 * What a path has to satisfy before this harness will ask an editor for it.
 *
 * The rule the brief asks for is "inside the session's project directory",
 * and half of it is not this process's to enforce. Verified rather than
 * assumed: a route cannot read the directory the editor opened the
 * conversation in. `surface()` and `hasSurface()` are the whole route-facing
 * API, `AgentSessionRecord.cwd` exists but the two store keys that reach it
 * are marked internal and their symbols are not exported, and the fn
 * handler's session view carries the agent and the id only.
 *
 * So the boundary is split, and saying which half is where is the point of
 * this file:
 *
 * - **The editor owns "inside the project".** ACP paths are absolute and the
 *   client decides what it will open; every editor implementing the protocol
 *   refuses to read outside the workspace the person opened. That is a real
 *   boundary, enforced by the program that owns the files.
 * - **This harness owns the spelling of the path**: absolute, no `..`
 *   segment, and no segment beginning with a dot, which is what keeps `.env`
 *   and `.git` out of a turn.
 *
 * A `..` segment is refused rather than resolved away. Resolving would make
 * the rule depend on knowing the root, which is the thing this cannot know;
 * refusing needs nothing but the string, and no legitimate path the model
 * should be asking for contains one.
 *
 * ## What these rules do not cover
 *
 * They are rules about the NAME, and the properties they are meant to protect
 * belong to the target. A symlink inside the project satisfies all three and
 * resolves anywhere: `/project/config` pointing at `~/.ssh/id_rsa` is read,
 * and the editor's own boundary does not help because the path it was given
 * genuinely is inside the workspace. ACP has no call that resolves a path, so
 * this cannot be closed from here; it is closed by not putting a program that
 * can create or follow one on the command allowlist without asking.
 *
 * They are also POSIX-shaped. A Windows editor's paths (`C:\...`) fail the
 * absolute test, so the three file capabilities refuse everything there while
 * the terminal ones keep working.
 */

/** Why a path was refused, or `undefined` when it is acceptable. */
export function pathRefusal(path: string): string | undefined {
  if (!path.startsWith("/")) {
    return `"${path}" is not an absolute path. The editor's file calls take absolute paths.`;
  }

  const segments = path.split("/").filter((segment) => segment !== "");

  if (segments.includes("..")) {
    return `"${path}" walks up out of the project with "..", which is refused rather than resolved.`;
  }

  const dotted = segments.find((segment) => segment.startsWith("."));
  if (dotted !== undefined) {
    return `"${path}" reaches "${dotted}", and this harness does not open dotfiles or dot-directories through the editor.`;
  }

  return undefined;
}

/**
 * A path this harness will hand to the editor's file calls.
 *
 * The three file capabilities share the field rather than the rule: the rule
 * is `pathRefusal` above, and what is shared here is the zod plumbing that
 * calls it, so a fourth capability cannot spell the refusal in a way that
 * stops naming which rule was broken.
 */
export const EditorPath = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    const refusal = pathRefusal(value);
    if (refusal !== undefined) ctx.addIssue({ code: "custom", message: refusal });
  })
  .describe("Absolute path to the file, inside the open project.");
