import { describe, expect, test } from "bun:test";
import { WebFetchInput } from "../capabilities/tools/web-fetch/route.js";
import { WebSearchInput } from "../capabilities/tools/web-search/route.js";

/**
 * The promise this template makes about a fresh scaffold: it reaches nothing
 * until someone decides where it may go.
 *
 * `test/setup.ts` runs with no `WEB_FETCH_ALLOWED_HOSTS` and no
 * `BRAVE_SEARCH_API_KEY`, which is the state of a project the moment it is
 * created. If either capability starts admitting a URL under those
 * conditions, this file fails, and it fails for the right reason: a template
 * that ships a working fetch-anything tool hands every scaffolded project an
 * egress path its owner never chose.
 */
describe("a fresh scaffold performs no egress", () => {
  /**
   * @case Every URL is refused while the allowlist is unset
   * @preconditions WEB_FETCH_ALLOWED_HOSTS absent, as in a fresh scaffold
   * @expectedResult Every candidate fails validation, so no request is made
   */
  test("web-fetch refuses every host", () => {
    for (const url of [
      "https://example.com/",
      "https://docs.routecraft.dev/",
      "http://localhost:8080/",
      "https://127.0.0.1/",
      "https://[::1]/",
    ]) {
      const result = WebFetchInput.safeParse({ url, question: "anything" });
      expect(result.success).toBe(false);
    }
  });

  /**
   * @case The refusal names the variable to set
   * @preconditions WEB_FETCH_ALLOWED_HOSTS absent
   * @expectedResult The message says which variable turns egress on, so the
   *   refusal is actionable rather than mysterious
   */
  test("web-fetch says how to turn egress on", () => {
    const result = WebFetchInput.safeParse({
      url: "https://example.com/",
      question: "anything",
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      "WEB_FETCH_ALLOWED_HOSTS",
    );
  });

  /**
   * @case Search refuses without a key rather than calling an endpoint
   * @preconditions BRAVE_SEARCH_API_KEY absent
   * @expectedResult Validation fails naming the variable, so nothing is sent
   *   to an endpoint that would answer 401
   */
  test("web-search refuses without a key", () => {
    const result = WebSearchInput.safeParse({ query: "anything" });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      "BRAVE_SEARCH_API_KEY",
    );
  });
});

/**
 * The positive half, run in a subprocess because the allowlist is read once
 * at import: proving that a configured allowlist admits the hosts it names
 * and nothing else needs a different environment, not a different input.
 */
describe("a configured allowlist", () => {
  const check = async (url: string, hosts: string): Promise<boolean> => {
    const script = `
      const { WebFetchInput } = await import("./capabilities/tools/web-fetch/route.ts");
      const result = WebFetchInput.safeParse({
        url: process.env.CANDIDATE_URL,
        question: "q",
      });
      console.log(result.success ? "yes" : "no");
    `;
    const proc = Bun.spawn(["bun", "-e", script], {
      env: {
        ...process.env,
        WEB_FETCH_ALLOWED_HOSTS: hosts,
        CANDIDATE_URL: url,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    return out.trim() === "yes";
  };

  /**
   * @case A listed host is admitted, and so is a subdomain of it
   * @preconditions WEB_FETCH_ALLOWED_HOSTS names one domain
   * @expectedResult Both the domain and a subdomain pass
   */
  test("admits a listed host and its subdomains", async () => {
    expect(await check("https://example.com/page", "example.com")).toBe(true);
    expect(await check("https://docs.example.com/page", "example.com")).toBe(
      true,
    );
  });

  /**
   * @case A host that merely ends with the same letters is refused
   * @preconditions The allowlist names example.com
   * @expectedResult notexample.com is refused, because the match is on host
   *   boundaries and not on string suffixes
   */
  test("refuses a host that only looks like a listed one", async () => {
    expect(await check("https://notexample.com/", "example.com")).toBe(false);
    expect(await check("https://example.com.evil.test/", "example.com")).toBe(
      false,
    );
  });

  /**
   * @case A non-web scheme is refused even on a listed host
   * @preconditions The allowlist names example.com
   * @expectedResult file: is refused, so an allowlisted host cannot be used
   *   to reach the local filesystem
   */
  test("refuses a scheme that is not http or https", async () => {
    expect(await check("file://example.com/etc/passwd", "example.com")).toBe(
      false,
    );
  });
});
