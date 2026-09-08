import { surface } from "@routecraft/ai";
import { craft, direct } from "@routecraft/routecraft";
import { z } from "zod";
import { requireEditor } from "../../../shared/editor.js";

/**
 * Show the person the plan, and tick it over as the work goes.
 *
 * Nothing in the framework knows what a plan is, and nothing here stores
 * one. This is a route that pushes a session update the editor renders as a
 * checklist, which is the whole feature: the state lives in the editor and
 * in the model's own head, and the protocol carries the picture between
 * them.
 *
 * The protocol replaces the whole plan on every update rather than patching
 * one entry, so the agent sends every step each time with its current
 * status. That is the protocol's choice and this route does not hide it:
 * an input that let the model send one changed entry would have to invent
 * the merge, and a merge nobody can see is where a plan silently loses a
 * step.
 *
 * `surface.notify` rather than `surface()`: this tells, and nothing waits.
 * A plan the agent has to wait for the editor to acknowledge would put a
 * round trip between every step and the next.
 */

const PlanEntry = z.object({
  content: z.string().min(1).describe("What this step is."),
  priority: z
    .enum(["high", "medium", "low"])
    .default("medium")
    .describe("How important the step is."),
  status: z
    .enum(["pending", "in_progress", "completed"])
    .describe("Where the step is now."),
});

export const UpdatePlanInput = z.object({
  entries: z
    .array(PlanEntry)
    .min(1)
    .describe(
      "Every step, each time, with its current status. The editor replaces the whole plan with what you send.",
    ),
});
export type UpdatePlanInput = z.infer<typeof UpdatePlanInput>;

export default craft()
  .id("update-plan")
  .description(
    "Show or update the plan in the editor. Send every step each time, with its current status.",
  )
  .input({ body: UpdatePlanInput })
  .from<UpdatePlanInput>(direct())
  .transform(async (input, exchange) => {
    requireEditor(exchange, "showing a plan");

    await surface
      .notify(() => ({
        sessionUpdate: "plan" as const,
        entries: input.entries,
      }))
      .send(exchange);

    return {
      shown: input.entries.length,
      done: input.entries.filter((entry) => entry.status === "completed")
        .length,
    };
  });
