import { surface } from "@routecraft/ai";
import { craft, direct } from "@routecraft/routecraft";
import type { ElicitationUrlMode } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { requireEditor } from "../../../shared/editor.js";

/**
 * Open a link in the person's browser, through the editor.
 *
 * ACP carries this as an elicitation in URL mode: the agent asks the client
 * to send the person somewhere, and the client decides how. Zed opens it.
 * Whether JetBrains does is UNVERIFIED here and could not be verified from
 * this container, which has no JetBrains to run.
 *
 * So the capability is built to be useful either way. The url is in the
 * answer whatever happens, and when the editor refuses the call or does not
 * implement it, that is reported as the link plus the reason rather than as
 * a failure: a person who can see the address can open it themselves, and a
 * tool that throws instead has turned a small inconvenience into a dead end.
 *
 * Only http and https. A `file:` url would ask the person's browser to open
 * something on their disk chosen by a model, and every other scheme is a
 * handler registration on their machine that neither of us can see.
 *
 * The call below is cast, and the cast is the adapter's typing rather than
 * this route's shape: `CreateElicitationRequest` is a union of a
 * session-scoped arm and a request-scoped one, and the adapter removes
 * `sessionId` because it fills that in itself. `Omit` does not distribute
 * over a union, so removing it takes the session arm's only required field
 * with it and the compiler is left offering the request-scoped arm. The
 * literal is written against `UrlElicitation` first so it is still checked
 * against the SDK's own type, and only the handover is cast.
 */

/** A session-scoped URL elicitation, minus what the adapter fills in. */
type UrlElicitation = Pick<ElicitationUrlMode, "elicitationId" | "url"> & {
  mode: "url";
  message: string;
};

export const OpenUrlInput = z.object({
  url: z
    .url()
    .refine((value) => /^https?:$/.test(new URL(value).protocol), {
      message: "Only http and https links can be opened.",
    })
    .describe("The link to open."),
  message: z
    .string()
    .min(1)
    .default("Open this link")
    .describe("Why the person is being sent there."),
});
export type OpenUrlInput = z.infer<typeof OpenUrlInput>;

export default craft()
  .id("open-url")
  .description("Open a link in the person's browser through their editor.")
  .input({ body: OpenUrlInput })
  .from<OpenUrlInput>(direct())
  .transform(async (input, exchange) => {
    requireEditor(exchange, "opening a link");

    const request = {
      mode: "url",
      elicitationId: `open-${Date.now()}`,
      url: input.url,
      message: input.message,
    } satisfies UrlElicitation;

    try {
      await surface(
        "elicitation/create",
        request as unknown as Parameters<
          typeof surface<"elicitation/create">
        >[1],
      ).fetch(exchange);
      return { url: input.url, opened: true };
    } catch (error: unknown) {
      // An editor that does not implement URL elicitation is a smaller
      // problem than it looks: the person can read the address.
      return {
        url: input.url,
        opened: false,
        note: `This editor did not open the link (${error instanceof Error ? error.message : String(error)}). The address is above; open it yourself.`,
      };
    }
  });
