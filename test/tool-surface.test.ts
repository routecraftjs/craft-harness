import { afterEach, describe, expect, test } from "bun:test";
import { agentPlugin, directTool } from "@routecraft/ai";
import { testContext, type TestContext } from "@routecraft/testing";
import { ARIA_TOOLS, ariaTools } from "../craft.config.js";
import bashRunner from "../capabilities/tools/bash-runner/route.js";
import mailReply from "../capabilities/mail/mail-reply/route.js";
import memorySave from "../capabilities/tools/memory-save/route.js";

/**
 * What the agent is offered, and what it is not.
 *
 * The tool list is declared unconditionally: `Direct(mail-reply)` is on it
 * whether or not a mailbox exists. Enablement is what removes it, and this
 * is the test that says so, because the alternative wording ("the model
 * knows not to call it") is not a boundary.
 */
describe("aria's tool surface", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.stop();
    t = undefined;
  });

  /**
   * @case A dormant capability is not offered to the agent
   * @preconditions A context holding two enabled capabilities and the mail
   *   route, which is disabled because no mailbox is configured
   * @expectedResult The enabled two resolve; mail-reply is absent, even
   *   though it is named unconditionally in the declared list
   */
  test("drops a disabled capability from the resolved tools", async () => {
    expect(ARIA_TOOLS).toContain("Direct(mail-reply)");

    t = await testContext()
      .with({
        plugins: [
          agentPlugin({ functions: { Bash: directTool("bash-runner") } }),
        ],
      })
      .routes([bashRunner, memorySave, mailReply])
      .build();
    await t.startAndWaitReady();

    const names = ariaTools.resolve(t.ctx).map((tool) => tool.name);
    expect(names).toContain("Bash");
    expect(names).toContain("direct__memory-save");
    expect(names).not.toContain("direct__mail-reply");
  });

  /**
   * @case The declared list names only capabilities this repository has
   * @preconditions The declared list, and the fn alias the config registers
   * @expectedResult Every Direct(...) entry names a route file that exists,
   *   so a renamed capability is caught here rather than by an agent quietly
   *   losing a tool
   */
  test("names only capabilities that exist", async () => {
    const ids = ARIA_TOOLS.filter((name) => name.startsWith("Direct(")).map(
      (name) => name.slice("Direct(".length, -1),
    );
    const { Glob } = await import("bun");
    const files = await Array.fromAsync(
      new Glob("capabilities/**/route.ts").scan("."),
    );
    const sources = await Promise.all(files.map((f) => Bun.file(f).text()));
    for (const id of ids) {
      expect(sources.some((s) => s.includes(`.id("${id}")`))).toBe(true);
    }
  });
});
