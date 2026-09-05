import { type LlmResult, llm } from "@routecraft/ai";
import { BODY_LIMIT, PROSE, boundedMarkup, extractInto } from "./extract.js";
import {
  craft,
  direct,
  http,
  isRedirect,
  only,
  otherwise,
  when,
  type HttpResult,
} from "@routecraft/routecraft";
import { z } from "zod";
import { env, modelId } from "../../../env.js";

/**
 * Fetch one page and answer a question about it.
 *
 * Every guardrail this capability has is a step in this file. That is the
 * point of writing it as a route: the allowlist, the hop rule, the rate
 * limit, the deadline, the retry and the cache are all readable in order,
 * and none of them is hidden behind a helper that could quietly stop
 * applying.
 *
 * ## The allowlist is a must-set placeholder
 *
 * `WEB_FETCH_ALLOWED_HOSTS` has no default and there is no wildcard. A fresh
 * scaffold therefore has an empty allowlist, `.input()` refuses every URL
 * with `RC5002`, and the harness makes no outbound request at all until
 * someone decides where it may go. A template that shipped a working
 * fetch-anything tool would be handing every scaffolded project an egress
 * path its owner never chose.
 *
 * ## Redirects are re-checked, not followed
 *
 * `redirect: "manual"` is what makes the allowlist mean anything: the
 * default would follow a 3xx to a host the route never approved, and the
 * check would have guarded only the first hop. The route takes at most one
 * hop, and re-runs the same allowlist rule on the `Location` before taking
 * it. A longer chain is refused rather than walked, which costs the rare
 * multi-hop shortener and buys a rule with no exceptions.
 */

/** Hosts the allowlist admits. Empty until someone sets the variable. */
const allowedHosts = env.WEB_FETCH_ALLOWED_HOSTS;

/**
 * Whether a URL is one this capability may request.
 *
 * Host equality or a dot-suffix match, never a substring: `evil-docs.com`
 * must not pass an allowlist entry of `docs.com`. Only http and https, so an
 * allowlisted host cannot be reached through `file:` or another scheme.
 */
function isAllowed(candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  return allowedHosts.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

export const WebFetchInput = z.object({
  url: z
    .url()
    .refine(isAllowed, {
      message:
        allowedHosts.length === 0
          ? "web-fetch has no allowed hosts. Set WEB_FETCH_ALLOWED_HOSTS before this capability can reach anything."
          : `Host is not in WEB_FETCH_ALLOWED_HOSTS (${allowedHosts.join(", ")}).`,
    })
    .describe("Page to read. Must be on the configured allowlist."),
  question: z.string().min(1).describe("What to find out from the page."),
});
export type WebFetchInput = z.infer<typeof WebFetchInput>;

const ANSWER_SYSTEM = [
  "Answer the question using only the page text supplied.",
  "Quote the wording of the page where it settles the question.",
  "If the page does not answer it, say so plainly instead of guessing.",
].join(" ");

/**
 * The body the answering branch reads.
 *
 * Restated because `llm()` types its prompt callbacks against
 * `Exchange<unknown>`, so the body type the builder has tracked this far does
 * not reach them.
 */
type PageText = { url: string; question: string; text: string };

/** What the caller is told when the page carried no readable text. */
const NO_TEXT =
  "The page carried no readable text, so the question could not be answered from it.";

/** Where the resolved redirect target rides between the filter and the hop. */
const REDIRECT_HEADER = "harness.fetch.redirect";

/**
 * The absolute URL a `Location` header names.
 *
 * `Location` is allowed to be relative, and documentation sites emit one on
 * every trailing-slash canonicalisation. Resolving it against the URL that
 * was requested is what makes the allowlist check apply to the request that
 * will actually be made, rather than refusing a same-host hop because a bare
 * `/en/docs` does not parse on its own.
 */
function resolveLocation(
  response: HttpResult,
  requested: string,
): string | undefined {
  const raw = response.headers["location"];
  if (typeof raw !== "string") return undefined;
  try {
    return new URL(raw, requested).href;
  } catch {
    return undefined;
  }
}

export default craft()
  .id("web-fetch")
  .description("Read one web page and answer a question about it.")
  .input({ body: WebFetchInput })
  // A model asking in a loop is the failure mode here, so the rate limit
  // paces rather than rejects: the agent waits instead of learning to retry.
  .throttle({ rate: 10, per: "minute" })
  .retry({ maxAttempts: 3, backoff: "500ms", factor: 2 })
  .timeout("30s")
  .cache({
    ttl: "5m",
    // Typed at the call site: route-scope wrappers are declared before
    // `.from()`, so the builder has no body type to infer from yet.
    key: (exchange) => {
      const body = exchange.body as WebFetchInput;
      return `${body.url}\n${body.question}`;
    },
  })
  .from<WebFetchInput>(direct())
  .enrich(
    http({
      url: (exchange: { body: WebFetchInput }) => exchange.body.url,
      redirect: "manual",
      maxBodySize: BODY_LIMIT,
      timeout: "15s",
    }),
    only((response: HttpResult) => response, "response"),
  )
  .choice(
    when(
      (exchange) => isRedirect(exchange.body.response),
      (branch) =>
        branch
          .header(REDIRECT_HEADER, (exchange) =>
            resolveLocation(exchange.body.response, exchange.body.url),
          )
          .filter((exchange) => {
            const next = exchange.headers[REDIRECT_HEADER];
            return typeof next === "string" && isAllowed(next)
              ? true
              : { reason: "redirect left the allowlist" };
          })
          .enrich(
            http({
              url: (exchange) =>
                String(exchange.headers[REDIRECT_HEADER] ?? ""),
              // The second hop is the last one. A 3xx here fails rather than
              // being followed, so the allowlist covers every request made.
              redirect: "error",
              maxBodySize: BODY_LIMIT,
              timeout: "15s",
            }),
            only((response: HttpResult) => response, "response"),
          ),
    ),
    // A choice with no matching branch drops the exchange, so the ordinary
    // case, a 200 that needs no hop, needs a branch of its own to survive.
    otherwise((branch) => branch),
  )
  .transform((body) => ({
    url: body.url,
    question: body.question,
    markup: boundedMarkup(body.response),
  }))
  .transform(extractInto(PROSE))
  // A page whose prose sits loose in divs matches no block. The whole
  // document loses the boundaries PROSE exists to keep, and beats handing the
  // model an empty page, which reads to the caller as the page not covering
  // their question.
  .choice(
    when(
      (exchange) => exchange.body.text === "" && exchange.body.markup !== "",
      (branch) => branch.transform(extractInto("body", { collapse: true })),
    ),
    otherwise((branch) => branch),
  )
  .choice(
    when(
      (exchange) => exchange.body.text !== "",
      (branch) =>
        branch
          .enrich(
            llm(modelId, {
              system: ANSWER_SYSTEM,
              user: (exchange) => {
                const body = exchange.body as PageText;
                return `Question: ${body.question}\n\nPage (${body.url}):\n\n${body.text}`;
              },
            }),
            only((result: LlmResult) => result.text, "answer"),
          )
          .transform((body) => ({
            url: body.url,
            question: body.question,
            answer: body.answer,
          })),
    ),
    otherwise((branch) =>
      branch.transform((body) => ({
        url: body.url,
        question: body.question,
        answer: NO_TEXT,
      })),
    ),
  );
