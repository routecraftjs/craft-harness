import { z } from "zod";
import { DEFAULT_PORTS } from "./shared/defaults.js";

/**
 * The project's environment contract, parsed once at import.
 *
 * `.env.schema` is the human-facing half of the same contract: it declares
 * every variable, what it is for, and whether it is required, without ever
 * carrying a value. This file is the machine-facing half, and
 * `test/env-contract.test.ts` fails the build when the two drift apart, so a
 * variable added to one and forgotten in the other cannot ship.
 *
 * Parsing at import means a misconfigured deployment fails at boot with the
 * offending variable named, rather than hours later inside whichever route
 * happened to read it first.
 */

/**
 * Comma-separated list, trimmed, empty entries dropped.
 *
 * The default belongs on the string rather than on the transform: a default
 * applied after `.transform()` has to be a function returning the parsed
 * shape, which puts the same list in the file twice in two spellings.
 */
const listOf = (fallback = ""): z.ZodType<string[], string | undefined> =>
  z
    .string()
    .default(fallback)
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    );

/** The empty-by-default list, which is what most of these are. */
const list = listOf();

/**
 * Hosts `web-fetch` may reach, lowercased for comparison against a parsed
 * URL's hostname.
 *
 * No default and no wildcard. An unset allowlist is an empty allowlist, which
 * the capability's own `.input()` then rejects every URL against, so a fresh
 * scaffold makes no outbound request until someone decides where it may go.
 */
const allowedHosts = list.transform((entries) =>
  entries.map((entry) => entry.toLowerCase()),
);

/**
 * Who may resolve an approval, and what they may approve.
 *
 * `subject=scope other:scope` per entry. The subject is whatever the approval
 * door authenticated; the scopes are the strings a `request-approval` call
 * names in its `scope` field.
 */
const approvers = list.transform((entries, ctx) => {
  const map: Record<string, string[]> = {};
  for (const entry of entries) {
    const equals = entry.indexOf("=");
    if (equals <= 0) {
      ctx.addIssue({
        code: "custom",
        message: `APPROVERS entry "${entry}" is not "subject=scope scope".`,
      });
      return z.NEVER;
    }
    const subject = entry.slice(0, equals).trim();
    const scopes = entry
      .slice(equals + 1)
      .split(/\s+/)
      .filter(Boolean);
    if (subject === "" || scopes.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: `APPROVERS entry "${entry}" needs a subject and at least one scope.`,
      });
      return z.NEVER;
    }
    map[subject] = scopes;
  }
  return map;
});

const envSchema = z.object({
  // Read by the framework rather than by this project, and declared here so
  // the contract is complete: outside development and test the MCP transport
  // demands an HTTPS MCP_URL, which is the difference `bun run dev` makes.
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),

  // The one credential that secures every surface this harness exposes.
  // `bun run setup` generates it; nothing in the repository ever holds it.
  // 32 characters is the floor rather than a preference: the key is a bearer
  // credential on a listening port, and a short one is guessable offline.
  CRAFT_API_KEY: z.string().min(32),

  LLM_API_KEY: z.string().min(1),
  LLM_PROVIDER: z
    .enum(["anthropic", "openai", "gemini", "openrouter", "ollama", "lmstudio"])
    .default("anthropic"),
  LLM_MODEL: z.string().min(1).default("claude-sonnet-4-5"),

  WEB_FETCH_ALLOWED_HOSTS: allowedHosts,

  // What `run-command` may run in the editor's terminal without asking. It
  // runs as the person, with their files and their network, so this list is
  // the boundary rather than a convenience. Anything not on it raises a
  // permission prompt in the editor before anything runs. Only programs that
  // cannot be told to run something else belong here: `bun`, `git`, `node`
  // and `cat` are each a way around the list rather than an entry on it.
  RUN_COMMAND_ALLOWLIST: listOf("rg,ls,pwd,echo"),
  // How long a command may run in the editor's terminal before it is killed
  // and reported as timed out. Fixed per instance rather than per call: a
  // caller that can raise its own deadline has no deadline.
  RUN_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  BRAVE_SEARCH_API_KEY: z.string().default(""),

  SCHEDULER_CRON: z.string().min(1).default("* * * * *"),
  HEARTBEAT_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),

  // At least 32 bytes, matching what the deferral runtime demands. Caught
  // here so a short secret fails naming the variable rather than deep inside
  // plugin startup.
  ROUTECRAFT_DEFERRAL_SECRET: z.string().min(32),
  APPROVAL_BASE_URL: z.url().default("http://localhost:8080"),
  APPROVERS: approvers,

  // The human-facing surface: an approval link someone opens from their mail
  // client, so it takes the conventional application port.
  HTTP_PORT: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PORTS.approvals),
  MCP_PORT: z.coerce.number().int().positive().default(DEFAULT_PORTS.mcp),
  // Also the MCP resource identifier (RFC 9728), which the transport requires
  // outside development and test. It must be the URL a client actually
  // reaches, so a deployment behind a proxy sets its public address here.
  MCP_URL: z.url().default("http://localhost:8081"),
  // The editor's door. A fourth listener rather than a share of the MCP one:
  // this project separates surfaces by purpose so a firewall rule can, and
  // two protocols behind one port removes that.
  ACP_PORT: z.coerce.number().int().positive().default(DEFAULT_PORTS.editor),
  // Management, kept off the application port. `craft exec` looks at 8080 by
  // default, but `bun run setup` writes the real url into
  // `.routecraft/settings.yaml`, so the CLI never needs the default or a flag.
  OPS_PORT: z.coerce.number().int().positive().default(DEFAULT_PORTS.ops),

  MAIL_ADDRESS: z.union([z.email(), z.literal("")]).default(""),
  MAIL_APP_PASSWORD: z.string().default(""),
  MAIL_IMAP_HOST: z.string().min(1).default("imap.gmail.com"),
  MAIL_SMTP_HOST: z.string().min(1).default("smtp.gmail.com"),
  MAIL_SMTP_PORT: z.coerce.number().int().positive().default(587),
  MAIL_FOLDER: z.string().min(1).default("INBOX"),
});

/** Every variable the harness reads, parsed and typed. */
export const env = envSchema.parse(process.env);

/**
 * Why the mail capabilities are dormant, or `true` when they are not.
 *
 * The shape `.enabled()` wants: `true` starts the route, and a string both
 * stops it and becomes the reason `/ops` reports. Returning the reason from
 * the same expression that decides is what stops the two drifting apart, so
 * the message an operator reads always names the variables actually missing
 * rather than a sentence someone wrote once.
 *
 * `craft.config.ts` reads the same predicate to decide whether to declare a
 * mail account at all, because an account with no credentials behind it is
 * not a useful thing to configure.
 */
export function mailEnabled(): true | string {
  const missing = [
    ...(env.MAIL_ADDRESS === "" ? ["MAIL_ADDRESS"] : []),
    ...(env.MAIL_APP_PASSWORD === "" ? ["MAIL_APP_PASSWORD"] : []),
  ];
  return missing.length === 0 ? true : `${missing.join(", ")} unset`;
}

/** Whether a mailbox is configured, for the config that declares the account. */
export const mailConfigured = mailEnabled() === true;

/** Model reference in the `provider:model` form the DSL takes. */
export const modelId = `${env.LLM_PROVIDER}:${env.LLM_MODEL}` as const;
