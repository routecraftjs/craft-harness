import { craft, direct, file } from "@routecraft/routecraft";
import { z } from "zod";
import {
  PROPOSED_SKILLS_ROOT,
  WORKSPACE_ROOT,
  resolveWithin,
} from "../../../shared/paths.js";

/**
 * Write a file the agent is allowed to write.
 *
 * The writable roots are the same two the read side allows, and for the
 * same reason: `workspace/` is the agent's own desk, and `skills/proposed/`
 * is where it drafts skills for a person to review. It cannot write into
 * `skills/` itself, which is what makes a proposed skill a proposal rather
 * than a self-granted capability.
 *
 * Nothing written here is loaded, imported or executed. A file the agent
 * wrote is data until a human moves it.
 */

const ROOTS = [
  { name: "workspace", root: WORKSPACE_ROOT },
  { name: "skills/proposed", root: PROPOSED_SKILLS_ROOT },
] as const;

/**
 * Header carrying the path the caller asked for.
 *
 * The file destination writes whatever the body is, so the body has to
 * become the content before the write. The path is envelope rather than
 * payload from that point on, which is exactly what a header is for. The
 * CALLER's path is what travels, not the resolved one: the absolute path is
 * derived where it is needed and is nobody else's business.
 */
const PATH_HEADER = "harness.workspace.path";

/** Resolve a caller path against the writable roots, or `undefined`. */
export function resolveWritable(candidate: string): string | undefined {
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

export const WorkspaceWriteInput = z.object({
  path: z
    .string()
    .min(1)
    .refine((value) => resolveWritable(value) !== undefined, {
      message:
        "Path must start with workspace/ or skills/proposed/ and stay inside it. skills/ itself is read-only to the agent.",
    })
    .describe("File to write, e.g. workspace/plan.md."),
  content: z.string().describe("Full new contents of the file."),
});
export type WorkspaceWriteInput = z.infer<typeof WorkspaceWriteInput>;

export default craft()
  .id("workspace-write")
  .description("Write a file in the agent workspace or propose a skill.")
  .input({ body: WorkspaceWriteInput })
  .from<WorkspaceWriteInput>(direct())
  // Non-null: `.input()` already refused every path that does not resolve,
  // and the filter chain runs it before any step here.
  .header(PATH_HEADER, (exchange) => exchange.body.path)
  .transform((body) => body.content)
  .tap(
    file({
      path: (exchange) =>
        resolveWritable(String(exchange.headers[PATH_HEADER]))!,
      createDirs: true,
    }),
  )
  .transform((content, exchange) => ({
    path: String(exchange.headers[PATH_HEADER]),
    bytes: Buffer.byteLength(content, "utf8"),
  }));
