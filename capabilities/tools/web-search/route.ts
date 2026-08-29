import { craft, direct, http, only } from "@routecraft/routecraft";
import { z } from "zod";
import { env } from "../../../env.js";

/**
 * Search the web and return results. Nothing more.
 *
 * This capability deliberately does not answer anything. It ranks and
 * condenses what the search API returned and hands that back, so what
 * reaches the agent is a list of sources it can choose to read with
 * `web-fetch`. A search tool that summarises has already decided what the
 * answer is, from snippets, with nothing to check it against; the two-step
 * shape keeps the reading and the answering visible as separate acts.
 *
 * The key comes from configuration and is never a parameter. Without it the
 * capability refuses at `.input()` rather than calling an endpoint that
 * would 401, so the message names the variable to set.
 */

export const WebSearchInput = z
  .object({
    query: z.string().min(1).max(400).describe("What to search for."),
    count: z.coerce
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe("How many results to return."),
  })
  // The key is a must-set placeholder, the same shape as web-fetch's
  // allowlist: without it the capability refuses here rather than calling an
  // endpoint that would answer 401, so the message names what to set.
  .refine(() => env.BRAVE_SEARCH_API_KEY !== "", {
    message:
      "web-search has no API key. Set BRAVE_SEARCH_API_KEY before this capability can search.",
  });
export type WebSearchInput = z.infer<typeof WebSearchInput>;

/** One result, condensed to what a decision to read the page needs. */
export const SearchResult = z.object({
  title: z.string(),
  url: z.url(),
  snippet: z.string(),
  age: z.string().optional(),
});
export type SearchResult = z.infer<typeof SearchResult>;

/** The shape of Brave's response this route reads, and only that. */
const BraveResponse = z.object({
  web: z
    .object({
      results: z
        .array(
          z.object({
            title: z.string().default(""),
            url: z.string().default(""),
            description: z.string().default(""),
            age: z.string().optional(),
            profile: z.object({ name: z.string() }).partial().optional(),
          }),
        )
        .default([]),
    })
    .optional(),
});

const SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

export default craft()
  .id("web-search")
  .description("Search the web and return ranked results with snippets.")
  .input({ body: WebSearchInput })
  .throttle({ rate: 10, per: "minute" })
  .retry({ maxAttempts: 3, backoff: "500ms", factor: 2 })
  .timeout("20s")
  .cache({
    ttl: "5m",
    key: (exchange) => {
      const body = exchange.body as WebSearchInput;
      return `${body.query}\n${body.count}`;
    },
  })
  .from<WebSearchInput>(direct())
  .enrich(
    http({
      url: SEARCH_URL,
      query: (exchange: { body: WebSearchInput }) => ({
        q: exchange.body.query,
        // Asked for wider than requested so the ranking step below has
        // something to rank. Trimming happens here, not at the provider.
        count: Math.min(20, exchange.body.count * 2),
      }),
      headers: {
        Accept: "application/json",
        // Configuration, never a parameter: a key a caller could pass is a
        // key a model could be talked into passing somewhere else.
        "X-Subscription-Token": env.BRAVE_SEARCH_API_KEY,
      },
      timeout: "15s",
    }),
    only((response: { body: unknown }) => response.body, "raw"),
  )
  // Ranking, in the open. Brave returns its own order; this keeps that order
  // as the base and pushes results with no usable description down, because
  // a result the agent cannot judge from its snippet costs it a fetch.
  .transform((body) => {
    const parsed = BraveResponse.safeParse(body.raw);
    const results = parsed.success ? (parsed.data.web?.results ?? []) : [];
    return {
      query: body.query,
      count: body.count,
      ranked: results
        .filter((result) => result.url !== "")
        .map((result, index) => ({
          result,
          score: index + (result.description.trim() === "" ? 100 : 0),
        }))
        .sort((left, right) => left.score - right.score)
        .map((scored) => scored.result),
    };
  })
  // Condensing, in the open. Only these four fields cross into the agent's
  // context; a raw search payload is mostly tracking metadata and would cost
  // more context than the results are worth.
  .transform((body) => ({
    query: body.query,
    results: body.ranked.slice(0, body.count).map((result): SearchResult => ({
      title: result.title,
      url: result.url,
      snippet: result.description.slice(0, 400),
      ...(result.age === undefined ? {} : { age: result.age }),
    })),
  }));
