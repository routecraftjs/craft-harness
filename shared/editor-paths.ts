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
 * - **This harness owns the rest**, and it is the half an editor will not do
 *   for you: no traversal, no dotfiles, never `.env`, and a size cap.
 *
 * A `..` segment is refused rather than resolved away. Resolving would make
 * the rule depend on knowing the root, which is the thing this cannot know;
 * refusing needs nothing but the string, and no legitimate path the model
 * should be asking for contains one.
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
