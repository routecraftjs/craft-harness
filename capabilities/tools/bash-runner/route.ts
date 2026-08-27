import { shell, untrusted } from "@routecraft/os";
import { craft, direct } from "@routecraft/routecraft";
import { z } from "zod";

/**
 * Run a shell script for the agent, inside a kernel isolation tier.
 *
 * There is no command allowlist and no argument inspection here, and that is
 * the design rather than an omission. Deciding whether `curl | sh` is
 * dangerous by looking at the string is a game the checker loses: the same
 * effect is reachable through a hundred spellings, and a checker that
 * usually works teaches everyone to trust a boundary that is not one. The
 * boundary is the tier. What the script may reach is what `unshare` lets it
 * reach, whatever it says.
 *
 * What the tier gives: no network egress, no view of host processes, none of
 * the caller's privileges. What it does NOT give: protection from reading
 * files the calling user can read. `~/.ssh` and `.env` are inside the same
 * filesystem view, so run the harness as a user whose files you are willing
 * to let a model read.
 *
 * ## macOS, stated rather than degraded
 *
 * `unshare` is Linux namespaces. There is no macOS equivalent shipped today
 * (`seatbelt` is a separate piece of work), and the tier is named for the
 * mechanism precisely so it cannot claim something it does not deliver. On
 * macOS this capability fails at the call with `OS1001` naming the missing
 * tier.
 *
 * That is the position this template takes: fail loudly, do not degrade.
 * Run the harness on Linux or inside a container, and remove this capability
 * on a host that cannot isolate. Writing `isolation: "none"` here would make
 * the tool work on macOS by handing a model an unsandboxed shell as the
 * calling user, which is a different product.
 */

export const BashInput = z.object({
  script: z
    .string()
    .min(1)
    .max(8_000)
    .describe(
      "Shell script to run with bash -c. No network. Output is captured.",
    ),
});
export type BashInput = z.infer<typeof BashInput>;

export default craft()
  .id("bash-runner")
  .description(
    "Run a shell script in an isolated sandbox and return its output.",
  )
  .input({ body: BashInput })
  .from<BashInput>(direct())
  .enrich(
    shell<BashInput>(
      "bash",
      // The script is marked untrusted: it came from a model, and marking is
      // what turns flag protection on for the value.
      (exchange) => ["-c", untrusted(exchange.body.script)],
      {
        // Stated, never inherited. An operator can harden this from the
        // environment; nothing can quietly weaken it.
        isolation: "unshare",
        network: false,
        // A non-zero exit is an answer the agent should read and reason
        // about, not an exception that loses the output that explains it.
        failOnNonZero: false,
        // Fixed rather than taken from the input: `shell()` reads the
        // timeout once per call site, so a model-supplied one would have to
        // be threaded through an option that does not accept a function,
        // and a model that can raise its own deadline has no deadline.
        timeout: 60_000,
      },
    ),
  );
