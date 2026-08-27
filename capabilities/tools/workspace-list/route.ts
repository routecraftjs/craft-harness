import {
  type DirectoryEntry,
  craft,
  direct,
  directory,
  only,
} from "@routecraft/routecraft";
import { z } from "zod";
import {
  PROPOSED_SKILLS_ROOT,
  WORKSPACE_ROOT,
  resolveWithin,
} from "../../../shared/paths.js";

/**
 * List what is in the workspace.
 *
 * Same two roots as read and write, same containment rule, applied in the
 * same place. Listing is a read, so it is the directory adapter's enricher
 * role rather than a source: a source would scan at startup and emit into a
 * route nobody asked, and this scan happens because the agent asked.
 */

const ROOTS = [
  { name: "workspace", root: WORKSPACE_ROOT },
  { name: "skills/proposed", root: PROPOSED_SKILLS_ROOT },
] as const;

/** Resolve a caller path against the listable roots, or `undefined`. */
export function resolveListable(candidate: string): string | undefined {
  for (const { name, root } of ROOTS) {
    if (candidate === name) return root;
    const stripped = candidate.startsWith(`${name}/`)
      ? candidate.slice(name.length + 1)
      : undefined;
    if (stripped === undefined) continue;
    const resolved = resolveWithin(root, stripped);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

export const WorkspaceListInput = z.object({
  path: z
    .string()
    .min(1)
    .default("workspace")
    .refine((value) => resolveListable(value) !== undefined, {
      message:
        "Path must be workspace or skills/proposed, or a directory inside one of them.",
    })
    .describe("Directory to list, e.g. workspace or workspace/notes."),
  recursive: z
    .boolean()
    .default(false)
    .describe("Descend into subdirectories."),
});
export type WorkspaceListInput = z.infer<typeof WorkspaceListInput>;

export default craft()
  .id("workspace-list")
  .description("List files in the agent workspace.")
  .input({ body: WorkspaceListInput })
  .from<WorkspaceListInput>(direct())
  .enrich(
    directory({
      path: (exchange) =>
        resolveListable((exchange.body as WorkspaceListInput).path)!,
      recursive: true,
    }),
    only((entries: DirectoryEntry[]) => entries, "entries"),
  )
  .transform((body) => ({
    path: body.path,
    files: body.entries
      // `recursive` is an option the adapter reads once, so the depth choice
      // is made here where the caller's answer is available. Listing wide and
      // trimming is cheap; a workspace is not a filesystem.
      .filter((entry) => body.recursive || !entry.relativePath.includes("/"))
      .map((entry) => ({
        path: `${body.path}/${entry.relativePath}`,
        size: entry.size,
        modifiedAt: entry.modifiedAt.toISOString(),
      })),
  }));
