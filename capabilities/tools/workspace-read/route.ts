import { craft, direct, file, only } from "@routecraft/routecraft";
import { z } from "zod";
import {
  PROPOSED_SKILLS_ROOT,
  WORKSPACE_ROOT,
  resolveWithin,
} from "../../../shared/paths.js";

/**
 * Read a file the agent is allowed to read.
 *
 * Two roots, and nothing else: `workspace/`, which is the agent's desk, and
 * `skills/proposed/`, so it can re-read a draft it wrote. The containment
 * rule is applied here, in this route's own `.input()`, rather than inside a
 * path helper, because a guardrail that is not visible where it is enforced
 * is one nobody notices going missing.
 *
 * Containment resolves the path first and compares after. `..`, an absolute
 * path, and a sibling directory whose name merely starts the same way
 * (`workspace-secrets/`) are all refused by the same comparison, where a
 * string prefix test lets the third through.
 */

/** The two roots, in the order a path is tried against them. */
const ROOTS = [
  { name: "workspace", root: WORKSPACE_ROOT },
  { name: "skills/proposed", root: PROPOSED_SKILLS_ROOT },
] as const;

/** Resolve a caller path against the readable roots, or `undefined`. */
export function resolveReadable(candidate: string): string | undefined {
  for (const { name, root } of ROOTS) {
    const stripped = candidate.startsWith(`${name}/`)
      ? candidate.slice(name.length + 1)
      : undefined;
    if (stripped === undefined) continue;
    const resolved = resolveWithin(root, stripped);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

export const WorkspaceReadInput = z.object({
  path: z
    .string()
    .min(1)
    .refine((value) => resolveReadable(value) !== undefined, {
      message:
        "Path must start with workspace/ or skills/proposed/ and stay inside it.",
    })
    .describe("File to read, e.g. workspace/notes.md."),
});
export type WorkspaceReadInput = z.infer<typeof WorkspaceReadInput>;

export default craft()
  .id("workspace-read")
  .description("Read a file from the agent workspace.")
  .input({ body: WorkspaceReadInput })
  .from<WorkspaceReadInput>(direct())
  .enrich(
    file({
      // Non-null: `.input()` already refused every path that does not
      // resolve, and this runs after it in the filter chain.
      path: (exchange) =>
        resolveReadable((exchange.body as WorkspaceReadInput).path)!,
    }),
    only((content: string) => content, "content"),
  )
  .transform((body) => ({ path: body.path, content: body.content }));
