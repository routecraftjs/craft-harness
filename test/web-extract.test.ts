import { describe, expect, test } from "bun:test";
import { html, type HtmlResult } from "@routecraft/routecraft";
import { PROSE, pageText } from "../capabilities/tools/web-fetch/route.js";

/** Run the page through the same extraction the route uses. */
async function extract(page: string, selector: string): Promise<HtmlResult> {
  const adapter = html({ selector, extract: "text" }) as unknown as {
    transform: (body: unknown) => Promise<HtmlResult>;
  };
  return await adapter.transform({ body: page });
}

const MINIFIED =
  `<body><h1>Getting started</h1><p>Install the package.</p>` +
  `<ul><li>one</li><li>two</li></ul>` +
  `<script>var secret="SCRIPT_BODY";</script>` +
  `<style>.a{color:red}</style></body>`;

/**
 * What the model is shown of a page.
 *
 * The regex this replaced stripped scripts, styles and comments and decoded
 * entities by hand. A parser has all of those rules already; what a parser
 * does NOT have for free is word boundaries, which is what these pin.
 */
describe("web-fetch extraction", () => {
  /**
   * @case Blocks stay apart on a page served without whitespace
   * @preconditions Minified HTML, which is most of the web, with no
   *   whitespace between the closing and opening tags of adjacent blocks
   * @expectedResult Each block is its own string. Taking the whole document's
   *   text instead concatenates descendants with nothing between them, so this
   *   page reads as "Getting startedInstall the package." and the model is
   *   asked to quote from words that were never on the page.
   */
  test("keep block boundaries on minified html", async () => {
    const extracted = await extract(MINIFIED, PROSE);
    expect(extracted).toEqual([
      "Getting started",
      "Install the package.",
      "one",
      "two",
    ]);
    expect(pageText(extracted)).toBe(
      "Getting started\nInstall the package.\none\ntwo",
    );
  });

  /**
   * @case Script and style bodies never reach the model
   * @preconditions A page carrying both, inline in the body
   * @expectedResult Neither appears. Beyond noise, page-controlled script text
   *   reaching a prompt is a page telling the model what to do.
   */
  test("leave script and style out", async () => {
    const text = pageText(await extract(MINIFIED, PROSE));
    expect(text).not.toContain("SCRIPT_BODY");
    expect(text).not.toContain("color:red");
  });

  /**
   * @case Entities arrive decoded
   * @preconditions A page using named entities in its prose
   * @expectedResult The characters, not the entities. The regex decoded five
   *   by hand and left every other one in the text.
   */
  test("decode entities the hand-rolled pass did not", async () => {
    const page = "<body><p>Ben &amp; Jerry&rsquo;s &mdash; 50&deg;</p></body>";
    const text = pageText(await extract(page, PROSE));
    expect(text).toContain("Ben & Jerry");
    expect(text).not.toContain("&amp;");
    expect(text).not.toContain("&deg;");
  });

  /**
   * @case A page with no prose blocks yields nothing, which is what the
   *   fallback in the route exists for
   * @preconditions Text sitting loose in a div, matching no block selector
   * @expectedResult The empty string. The route branches on exactly this and
   *   re-extracts from `body`, because answering from an empty page reads to
   *   the caller as the page not covering their question.
   */
  test("yield nothing when a page has no prose blocks", async () => {
    const loose = "<body><div>Loose text with no block element</div></body>";
    expect(pageText(await extract(loose, PROSE))).toBe("");
    expect(pageText(await extract(loose, "body"))).toContain("Loose text");
  });

  /**
   * @case The text handed to the model is capped
   * @preconditions A page longer than the limit
   * @expectedResult Truncated, so one enormous page cannot become the whole
   *   context window
   */
  test("cap the text at the documented limit", async () => {
    const long = `<body><p>${"word ".repeat(20_000)}</p></body>`;
    expect(pageText(await extract(long, PROSE)).length).toBe(40_000);
  });
});
