import { describe, expect, test } from "bun:test";
import { bootServer } from "@routecraft/testing";
import { craftConfig } from "../craft.config.js";

/**
 * The editor's door, and the wall in front of it.
 *
 * Two claims live here, and neither can be read off the config object alone.
 * The first is that the `acp:` key actually serves the protocol: it applies
 * after `agent` whatever order the keys are written in, and a context whose
 * registry is empty when it applies fails the build instead. The second is
 * that the mount is walled by the same credential as everything else, which
 * is the only reason it is safe to have on from boot.
 *
 * Both are answered by speaking to a running server rather than by reading a
 * structure, because a mount that is declared and not reachable looks
 * identical from the config and fails only in somebody's editor.
 */
describe("the editor mount", () => {
  /**
   * A context carrying the `acp:` key with the agent key written AFTER it,
   * which is the ordering the plugin-array form cannot express. The agent is
   * a stand-in for aria: this is about the mount, and loading the real
   * markdown agent would put a model provider in the way of that.
   */
  const boot = (): ReturnType<typeof bootServer> =>
    bootServer((builder) =>
      builder.with({
        acp: { server: "default", agent: "aria" },
        agent: {
          agents: {
            aria: {
              description: "The harness agent.",
              system: "You are Aria.",
            },
          },
        },
        servers: {
          default: {
            host: "127.0.0.1",
            port: 0,
            auth: {
              validator: (token: string) => {
                if (token !== "the-key") throw new Error("unknown token");
                return {
                  kind: "custom",
                  scheme: "bearer",
                  subject: "operator",
                } as const;
              },
            },
          },
        },
      }),
    );

  const initialize = (port: number, headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${port}/acp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      }),
    });

  /**
   * @case The protocol is served from boot, with the agent key written after
   *   the acp key
   * @preconditions A context carrying both first-party keys and a credential
   * @expectedResult `initialize` is answered, which is only possible if the
   *   mount built its route from an agent registry that was already
   *   populated when it applied
   */
  test("answers the protocol on the walled server", async () => {
    const { ctx, port } = await boot();
    try {
      const response = await initialize(port, {
        authorization: "Bearer the-key",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        result?: { protocolVersion?: number };
      };
      expect(body.result?.protocolVersion).toBe(1);
    } finally {
      await ctx.stop();
    }
  });

  /**
   * @case A caller with no credential is refused
   * @preconditions The same context
   * @expectedResult 401 and no protocol answer. The mount is on from boot in
   *   a fresh scaffold, so the wall is what makes that a defensible default
   *   rather than an open door on a laptop.
   */
  test("refuses a request carrying no key", async () => {
    const { ctx, port } = await boot();
    try {
      const response = await initialize(port, {});

      expect(response.status).toBe(401);
    } finally {
      await ctx.stop();
    }
  });

  /**
   * @case Every listener this instance opens carries the wall
   * @preconditions The project's own config
   * @expectedResult All four verify a credential. A fifth server added
   *   without one would be a hole nobody had to write down, and the editor
   *   door is the newest and least obvious of the four.
   */
  test("every declared server is walled", () => {
    const servers = craftConfig.servers ?? {};
    expect(Object.keys(servers).sort()).toEqual([
      "approvals",
      "editor",
      "mcp",
      "ops",
    ]);
    for (const [name, server] of Object.entries(servers)) {
      expect(`${name}: ${"auth" in server && server.auth !== undefined}`).toBe(
        `${name}: true`,
      );
    }
  });

  /**
   * @case The mount is on the editor's own listener, answering as Aria
   * @preconditions The project's own config
   * @expectedResult It names the `editor` server and names the agent. The
   *   default agent only resolves for a context holding exactly one, and
   *   this one holds aria and researcher, so leaving it unset would refuse
   *   `session/new` rather than answer.
   */
  test("is mounted on the editor server and names its agent", () => {
    expect(craftConfig.acp?.server).toBe("editor");
    expect(craftConfig.acp?.agent).toBe("aria");
  });
});
