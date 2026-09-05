import {
  html,
  type HtmlResult,
  type HttpResult,
  type Transformer,
} from "@routecraft/routecraft";

/**
 * How a fetched page becomes the text a model is asked about.
 *
 * The parsing itself is `html()` in the route. What lives here is the policy
 * around it, which only makes sense as one set: which elements count as
 * prose, how much markup is worth parsing, and how much of the result the
 * model is shown. Spread across the route they agreed only by coincidence.
 */

/**
 * The elements a page keeps its prose in.
 *
 * Extracting per block rather than taking the whole document's text is what
 * keeps word boundaries: cheerio's `.text()` concatenates descendants with
 * nothing between them, so a minified page, which is most of them, comes back
 * as "Getting startedInstall the package."
 *
 * Deliberately not `div`: divs nest, and each one yields all of its
 * descendants' text, so including them repeats most of the page once per
 * level. Widening this list shrinks how often the route falls back to the
 * whole document; narrowing it widens it, and that fallback is the shape this
 * list exists to avoid.
 */
export const PROSE =
  "h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,td,th,figcaption,dt,dd";

/** How much of a page the model is shown. */
export const TEXT_LIMIT = 40_000;

/**
 * How much markup is parsed at all.
 *
 * `.timeout()` cannot save the route here: cheerio parses synchronously, so a
 * 4MB body holds the event loop for the whole harness rather than just this
 * exchange, and the deadline is only noticed once the parse has finished. So
 * the cap has to land on the markup, before the expensive half, rather than
 * on the text after it. It sits far above {@link TEXT_LIMIT} because markup
 * is mostly tags: 500KB of a page comfortably carries the 40K of prose the
 * model is shown.
 */
export const HTML_LIMIT = 500_000;

/**
 * The markup worth parsing, or the empty string when the response was not a
 * page.
 *
 * The allowlist gates hosts, not media types, so an allowed host can answer
 * with JSON, a PDF or an image. Handing that to the parser matches no block
 * and then, on the fallback, yields the literal text of whatever it was: an
 * object reaches the model as "[object Object]" and is answered as though it
 * were the page.
 *
 * A response with no declared type is treated as markup, because that is
 * usually what a server omitting the header is serving.
 */
export function boundedMarkup(response: HttpResult): string {
  const declared = response.headers["content-type"];
  if (typeof declared === "string") {
    const type = declared.split(";")[0]?.trim().toLowerCase() ?? "";
    if (
      type !== "" &&
      type !== "text/html" &&
      type !== "application/xhtml+xml"
    ) {
      return "";
    }
  }
  return typeof response.body === "string"
    ? response.body.slice(0, HTML_LIMIT)
    : "";
}

/**
 * An extraction step: parse `markup`, put the readable text on `text`.
 *
 * A step rather than a call, so the route composes the parser the way it
 * composes everything else and the exchange keeps flowing. Both the prose
 * pass and the whole-document fallback are the same step with a different
 * selector, which is what keeps them from drifting apart.
 */
export function extractInto<T extends { markup: string }>(
  selector: string,
): Transformer<T, T & { text: string }> {
  return html<T, T & { text: string }>({
    selector,
    extract: "text",
    from: (body) => body.markup,
    to: (body, result) => ({ ...body, text: joinBlocks(result) }),
  });
}

/**
 * Join whatever the selector produced into the text the model is shown.
 *
 * `html()` answers an array when the selector matched more than once, a bare
 * string when it matched exactly once, and the empty string when it matched
 * nothing. Empty and whitespace-only matches are dropped rather than joined:
 * a page of empty table cells would otherwise spend the whole
 * {@link TEXT_LIMIT} budget on blank lines.
 */
export function joinBlocks(extracted: HtmlResult): string {
  const parts = Array.isArray(extracted) ? extracted : [extracted];
  return parts
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part !== "")
    .join("\n")
    .slice(0, TEXT_LIMIT);
}
