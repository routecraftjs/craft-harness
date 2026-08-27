import { agents, directTool, skills, tools } from "@routecraft/ai";
import { type CraftConfig, defineConfig } from "@routecraft/routecraft";
import { env, mailConfigured, modelId } from "./env.js";

/**
 * What the folder convention cannot work out on its own.
 *
 * `craft start` discovers the capabilities, the agents and the house skills
 * from disk, so none of them is listed here. What is listed is everything
 * that needs a decision: which listeners exist, which model provider is in
 * use, what an agent may call, and which parts of the harness exist at all
 * given what is configured.
 *
 * The rule for adding something here is that discovery could not have known
 * it. A capability belongs in `capabilities/`; a prompt belongs in
 * `agents/`; the fact that mail is dormant without a mailbox belongs here.
 */

/**
 * Aria's tool surface.
 *
 * Declared here rather than in `agents/aria.md` frontmatter because it is
 * conditional: the mail capabilities do not exist without a mailbox, and a
 * tool list naming a route that was never registered fails at resolution.
 * YAML cannot ask whether a mailbox is configured.
 *
 * `Bash` is an alias: the fn registry maps that familiar name onto the
 * `bash-runner` capability, so the model sees a name it knows while the
 * thing it reaches is an ordinary route in this repository.
 */
const ariaTools = tools([
  "Bash",
  "Direct(web-search)",
  "Direct(web-fetch)",
  "Direct(workspace-read)",
  "Direct(workspace-write)",
  "Direct(workspace-list)",
  "Direct(memory-save)",
  "Direct(memory-recall)",
  "Direct(schedule-task)",
  "Direct(list-schedules)",
  "Direct(cancel-schedule)",
  "Direct(request-approval)",
  "Direct(compact)",
  ...(mailConfigured ? ["Direct(mail-reply)"] : []),
]);

export const craftConfig: CraftConfig = defineConfig({
  name: "craft-harness",

  /**
   * Three listeners, deliberately not one. The approval door is reachable by
   * whoever was mailed a link; the MCP transport is where an assistant
   * connects; the ops surface is what `craft exec` and `craft ops` talk to
   * and has no business being on either of the other two.
   */
  servers: {
    approvals: { host: "localhost", port: env.HTTP_PORT },
    mcp: { host: "localhost", port: env.MCP_PORT },
    ops: { host: "localhost", port: env.OPS_PORT },
  },

  http: {
    mounts: {
      // No wall: the approval link is the credential at the floor. Put a
      // validator here (`jwks({...})`) and `approval-callback`'s hook starts
      // demanding a verified approver instead, with no route change.
      approvals: { path: "/", server: "approvals", auth: false },
    },
  },

  /**
   * `details: "always"` is stated rather than left to default. The default
   * withholds per-component health details unless a validator is in scope,
   * and this surface deliberately has none: it is bound to loopback, and
   * `craft exec` and `craft ops` are the local tools that read it. Put the
   * ops server on a routable address and this line is the first thing to
   * revisit, along with `servers.ops.auth`.
   */
  ops: {
    server: "ops",
    health: { details: "always" },
    /**
     * Every management tier is off unless named here. These two are what
     * `craft exec` needs: one to list what can be dispatched, one to
     * dispatch. `true` means no credential is demanded, which is right for a
     * loopback-bound surface and wrong the moment it is not. On a routable
     * address, give the ops mount a validator and replace both `true`s with
     * the scope string your tokens carry.
     */
    tiers: { introspection: true, dispatch: true },
  },

  suspension: {
    // Parked approvals must outlive a restart, which is the entire point of
    // parking them. The default store is SQLite where a driver is available.
    secret: env.ROUTECRAFT_SUSPENSION_SECRET,
  },

  llm: {
    providers: { [env.LLM_PROVIDER]: { apiKey: env.LLM_API_KEY } },
  },

  agent: {
    agents: await agents("./agents", {
      aria: {
        tools: ariaTools,
        blocks: await skills({ source: "./skills" }),
      },
    }),
    functions: {
      Bash: directTool("bash-runner"),
    },
    defaultOptions: { model: modelId },
    /**
     * An allowlist over the whole tool surface. Every kind must be decided,
     * which is what stops a later edit narrowing the surface by accident.
     *
     * `mcp: false` is the load-bearing one: this harness is an MCP SERVER,
     * and a tool discovered from some external MCP client is reach nobody in
     * this repository granted. Wrap one in a capability if the agent needs
     * it; then it is a route with a name, an input schema and a diff.
     */
    toolPolicy: { fn: true, direct: true, mcp: false },
  },

  mcp: {
    name: "craft-harness",
    title: "Craft Harness",
    version: "0.1.0",
    transport: "http",
    server: "mcp",
    // The resource identifier clients verify against (RFC 9728). Required
    // for the HTTP transport outside development, and it has to be the
    // address a client actually reaches rather than this process's port.
    resource: { url: env.MCP_URL },
  },

  /**
   * Dormant until a mailbox is configured. The key is omitted entirely
   * rather than declared empty, and the mail capabilities export no routes
   * on the same condition, so an unconfigured harness has no mail accounts,
   * no IMAP connection and nothing in the registry that claims otherwise.
   */
  ...(mailConfigured
    ? {
        mail: {
          accounts: {
            default: {
              imap: {
                host: env.MAIL_IMAP_HOST,
                auth: {
                  user: env.MAIL_ADDRESS,
                  pass: env.MAIL_APP_PASSWORD,
                },
              },
              smtp: {
                host: env.MAIL_SMTP_HOST,
                port: env.MAIL_SMTP_PORT,
                secure: false,
                requireTLS: true,
                auth: {
                  user: env.MAIL_ADDRESS,
                  pass: env.MAIL_APP_PASSWORD,
                },
                from: env.MAIL_ADDRESS,
              },
            },
          },
          folder: env.MAIL_FOLDER,
        },
      }
    : {}),
});
