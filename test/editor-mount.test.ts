import { describe, expect, test } from "bun:test";
import { bootServer, type BootedServer } from "@routecraft/testing";
import { OPERATOR_SUBJECT, craftConfig } from "../craft.config.js";
import { initialize } from "../scripts/check-editor-door.js";
import { EDITOR_AGENT } from "../shared/defaults.js";

/**
 * The editor's door, and the wall in front of it.
 *
 * Two claims live here, and neither can be read off the config object. The
 * first is that the `acp:` key actually serves the protocol: it applies
 * after `agent` whatever order the keys are written in, and a context whose
 * registry is empty when it applies fails the build instead. The second is
 * that the wall in front of it is real, because the mount is on from boot in
 * a fresh scaffold and that is only defensible if an anonymous caller is
 * refused.
 *
 * The requests go through `initialize` from the CI probe, so this file and
 * the check that runs against a real instance send the same bytes.
 *
 * Two things are deliberately not covered here. The project's own
 * `craft.config.ts` booted on its own ports is the probe's job in the boot
 * job, because binding four fixed ports inside the suite would collide with
 * whatever is already running. And `session/new` answers 202 with its reply
 * on the event stream rather than on the post, so asserting what an unnamed
 * agent does to a two-agent context needs a client that reads that stream.
 */
describe("the editor mount", () => {
  /**
   * A context carrying the `acp:` key with the agent key written AFTER it,
   * which is the ordering the plugin-array form cannot express.
   *
   * The agent is a stand-in for the real one: this is about the mount, and
   * loading the markdown agent would put a model provider in the way of it.
   */
  const boot = (): Promise<BootedServer> =>
    bootServer((builder) =>
      builder.with({
        acp: { server: "default", agent: EDITOR_AGENT },
        agent: {
          agents: {
            [EDITOR_AGENT]: {
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
                  subject: OPERATOR_SUBJECT,
                } as const;
              },
            },
          },
        },
      }),
    );

  const url = (port: number): string => `http://127.0.0.1:${port}`;

  /**
   * @case The protocol is served from boot, with the agent key written after
   *   the acp key
   * @preconditions A context carrying both first-party keys and a credential
   * @expectedResult `initialize` is answered with a protocol result, which is
   *   only possible if the mount built its route from an agent registry that
   *   was already populated when it applied
   */
  test("answers the protocol on the walled server", async () => {
    const { ctx, port } = await boot();
    try {
      const response = await initialize(url(port), {
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
      const response = await initialize(url(port));

      expect(response.status).toBe(401);
    } finally {
      await ctx.stop();
    }
  });

  /**
   * @case Every listener this instance opens carries the wall
   * @preconditions The project's own config
   * @expectedResult Each server verifies a credential. Stated as the rule
   *   rather than as the roster: pinning the set of names would fail for a
   *   legitimate fifth server with a message about a mismatched array, and
   *   the next reader would edit the array rather than add the wall.
   */
  test.each(Object.entries(craftConfig.servers ?? {}))(
    "the %s server is walled",
    (_name, server) => {
      expect("auth" in server && server.auth !== undefined).toBe(true);
    },
  );
});
