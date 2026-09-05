import { describe, expect, test } from "bun:test";
import { html, type HtmlResult, type HttpResult } from "@routecraft/routecraft";
import {
  HTML_LIMIT,
  PROSE,
  TEXT_LIMIT,
  boundedMarkup,
  joinBlocks,
} from "../capabilities/tools/web-fetch/extract.js";

/**
 * Run markup through the same adapter the route composes.
 *
 * The transformer role's `transform` takes the body alone, but the shared
 * `Transformer` type requires an exchange it never reads, so calling it
 * outside a route needs the narrower shape.
 */
function extract(markup: string, selector: string): Promise<HtmlResult> {
  const adapter = html({ selector, extract: "text" }) as unknown as {
    transform: (body: unknown) => Promise<HtmlResult>;
  };
  return adapter.transform(markup);
}

/** A response carrying markup, as `http()` hands it to the extraction steps. */
function response(body: unknown, contentType?: string): HttpResult {
  return {
    status: 200,
    headers: contentType === undefined ? {} : { "content-type": contentType },
    body,
  } as HttpResult;
}

const MINIFIED =
  `<body><h1>Getting started</h1><p>Install the package.</p>` +
  `<ul><li>one</li><li>two</li></ul>` +
  `<script>var secret="SCRIPT_BODY";</script>` +
  `<style>.a{color:red}</style></body>`;

/**
 * What the model is shown of a page.
 *
 * Entity decoding and dropping script and style content come free with a
 * parser. Word boundaries between blocks do not, and they are what these pin.
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
    expect(joinBlocks(extracted)).toBe(
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
    const text = joinBlocks(await extract(MINIFIED, PROSE));
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
    const page = "<body><p>Ben &amp; Jerry&rsquo;s, 50&deg;</p></body>";
    const text = joinBlocks(await extract(page, PROSE));
    expect(text).toContain("Ben & Jerry");
    expect(text).not.toContain("&amp;");
    expect(text).not.toContain("&deg;");
  });

  /**
   * @case A single match arrives as a bare string, not an array
   * @preconditions A page with exactly one prose block
   * @expectedResult The text, unchanged. `html()` answers `string | string[]`
   *   by match count, so a joiner that assumed an array would spell a
   *   one-block page out character by character.
   */
  test("join a single match", async () => {
    const extracted = await extract("<body><p>Only one</p></body>", PROSE);
    expect(extracted).toBe("Only one");
    expect(joinBlocks(extracted)).toBe("Only one");
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
    expect(joinBlocks(await extract(loose, PROSE))).toBe("");
    expect(joinBlocks(await extract(loose, "body"))).toContain("Loose text");
  });

  /**
   * @case A code sample keeps the markup the page escaped
   * @preconditions A `<pre>` whose content is escaped markup, the shape every
   *   documentation page uses for a generic or an HTML example
   * @expectedResult The markup survives. The parser used to strip anything
   *   tag-shaped after it had already decoded the entities, which deleted the
   *   only thing the escaping existed to carry.
   */
  test("escaped markup survives extraction", async () => {
    const page = `<body><pre>type X = Array&lt;string&gt;;</pre></body>`;
    expect(joinBlocks(await extract(page, PROSE))).toBe(
      "type X = Array<string>;",
    );
  });

  /**
   * @case A code sample keeps its line breaks and indentation
   * @preconditions A `<pre>` holding indented multi-line source
   * @expectedResult The lines and their indentation arrive intact. Collapsing
   *   whitespace puts the sample back on one line, which loses the structure
   *   for any language and the meaning for an indentation-sensitive one.
   */
  test("multi-line code keeps its shape", async () => {
    const page = `<body><pre>def f(x):\n    if x:\n        return 1\n</pre></body>`;
    expect(joinBlocks(await extract(page, PROSE))).toBe(
      "def f(x):\n    if x:\n        return 1",
    );
  });

  /**
   * @case Empty blocks do not spend the budget
   * @preconditions A page of empty and whitespace-only cells around one line
   *   of prose, the shape of a layout table
   * @expectedResult Only the prose. Joining the empty matches instead fills
   *   the text the model is shown with blank lines, and a wide enough table
   *   pushes the real content past the cap.
   */
  test("drop empty and whitespace-only blocks", async () => {
    const table =
      `<body><table><tr><td></td><td>   </td><td>The answer</td>` +
      `<td>\n\t</td></tr></table></body>`;
    expect(joinBlocks(await extract(table, PROSE))).toBe("The answer");
  });

  /**
   * @case The whole-document fallback does not spend its budget on the page's
   *   own indentation
   * @preconditions A pretty-printed page whose prose sits loose in divs, so
   *   PROSE matches nothing and the route falls back to the whole document
   * @expectedResult The prose, with the source's inter-tag whitespace gone.
   *   PROSE already claims `pre`, so a page that reaches the fallback has no
   *   code sample to protect, and leaving the whitespace in costs it four
   *   fifths of the text the model is shown.
   */
  test("the fallback collapses the page's own whitespace", async () => {
    const loose =
      `<body>\n  <div>\n    <span>Getting started</span>\n` +
      `    <div>\n      <span>Install it.</span>\n    </div>\n  </div>\n</body>`;
    expect(joinBlocks(await extract(loose, PROSE))).toBe("");
    expect(joinBlocks(await extract(loose, "body"), true)).toBe(
      "Getting started Install it.",
    );
  });

  /**
   * @case The text handed to the model is capped
   * @preconditions A page longer than the limit
   * @expectedResult Truncated, so one enormous page cannot become the whole
   *   context window
   */
  test("cap the text at the documented limit", async () => {
    const long = `<body><p>${"word ".repeat(20_000)}</p></body>`;
    expect(joinBlocks(await extract(long, PROSE)).length).toBe(TEXT_LIMIT);
  });

  /**
   * @case Markup is capped before it is parsed, not after
   * @preconditions A response far larger than the parse limit
   * @expectedResult Cut to the limit. cheerio parses synchronously, so a body
   *   at the 4MB fetch ceiling holds the event loop for the whole harness and
   *   the route's own deadline is only noticed once the parse has finished.
   */
  test("cap the markup before parsing it", () => {
    const huge = `<body><p>${"x".repeat(2_000_000)}</p></body>`;
    expect(boundedMarkup(response(huge, "text/html")).length).toBe(HTML_LIMIT);
  });

  /**
   * @case An allowlisted host answering with something other than a page
   * @preconditions JSON, and a body that is not a string at all
   * @expectedResult Nothing to extract. The allowlist gates hosts, not media
   *   types, and the fallback would otherwise hand the model the literal text
   *   of whatever came back, so an object reaches it as "[object Object]" and
   *   is answered as though it were the page.
   */
  test("refuse a response that is not a page", () => {
    expect(boundedMarkup(response("{}", "application/json"))).toBe("");
    expect(boundedMarkup(response({ a: 1 }, "text/html"))).toBe("");
  });

  /**
   * @case A server that declares no type
   * @preconditions A response with markup and no content-type header
   * @expectedResult Treated as a page, because that is what a server omitting
   *   the header is usually serving
   */
  test("treat an undeclared type as markup", () => {
    expect(boundedMarkup(response("<p>hi</p>"))).toBe("<p>hi</p>");
    expect(
      boundedMarkup(response("<p>hi</p>", "text/html; charset=utf-8")),
    ).toBe("<p>hi</p>");
  });
});
