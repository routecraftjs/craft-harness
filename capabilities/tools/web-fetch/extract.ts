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

/**
 * How much of a response is fetched at all.
 *
 * The top rung of the ladder {@link HTML_LIMIT} and {@link TEXT_LIMIT}
 * continue. Both hops share it: a redirect that could pull a larger body than
 * the first request was allowed would be a way around the bound.
 */
export const BODY_LIMIT = 4_000_000;

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
 *
 * `collapse` is for the fallback. {@link PROSE} already claims `pre`, so a
 * page that reaches the whole document has no code sample to protect and
 * nothing but the page's own inter-tag whitespace to lose.
 */
export function extractInto<T extends { markup: string }>(
  selector: string,
  options: { collapse?: boolean } = {},
): Transformer<T, T & { text: string }> {
  return html<T, T & { text: string }>({
    selector,
    extract: "text",
    from: (body) => body.markup,
    to: (body, result) => ({
      ...body,
      text: joinBlocks(result, options.collapse ?? false),
    }),
  });
}

/**
 * Join whatever the selector produced into the text the model is shown.
 *
 * `html()` answers an array when the selector matched more than once, a bare
 * string when it matched exactly once, and the empty string when it matched
 * nothing.
 *
 * Blank lines and trailing whitespace go, leading whitespace stays. That is
 * what keeps a `pre` block's line breaks and indentation, which is most of
 * what a code sample means. Collapsing instead is right only where there is
 * no structure to keep, which is the whole-document fallback: four fifths of
 * what `body` yields on a pretty-printed page is the source's own indentation,
 * and left alone it spends the {@link TEXT_LIMIT} budget the fallback exists
 * to fill.
 */
export function joinBlocks(extracted: HtmlResult, collapse = false): string {
  const parts = Array.isArray(extracted) ? extracted : [extracted];
  return parts
    .map((part) => (collapse ? part.replace(/\s+/g, " ") : squeezeLines(part)))
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join("\n")
    .slice(0, TEXT_LIMIT);
}

/** Drop blank lines and trailing whitespace, keep indentation. */
function squeezeLines(part: string): string {
  return part
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .join("\n");
}
