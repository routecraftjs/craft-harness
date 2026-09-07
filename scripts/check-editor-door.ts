/**
 * Prove the editor door is serving the protocol, and only with the key.
 *
 * Two assertions, against a running instance: an anonymous `initialize` is
 * refused, and one carrying the credential comes back with a protocol
 * result. That pair is the whole promise of having the mount on from boot,
 * so CI runs it on every push and a person can run the same command against
 * their own `bun run dev` and read the same output.
 *
 * It lives here rather than in a workflow step because a check nobody can
 * run locally is one people debug by pushing. It does not start or stop the
 * instance: whoever runs it owns that, which keeps this script a probe.
 *
 * Exits 0 when both hold, 1 with the offending body when either does not.
 */

import { DEFAULT_PORTS } from "../shared/defaults.js";

/** How long to wait for the listener to bind, in seconds. */
const BIND_TIMEOUT_SECONDS = 60;

/** The one request that proves the protocol rather than merely the wall. */
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: 1, clientCapabilities: {} },
} as const;

/**
 * Ask the editor door to initialize.
 *
 * Exported so `test/editor-mount.test.ts` sends the same bytes this does.
 * The path, the accept pair and the body are the wire contract, and a
 * second copy of them is a second thing to update when the protocol moves.
 */
export function initialize(
  baseUrl: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl.replace(/\/+$/, "")}/acp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(INITIALIZE),
  });
}

/** Wait for something to answer, or report that nothing ever bound. */
async function waitForListener(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < BIND_TIMEOUT_SECONDS; attempt += 1) {
    try {
      // Any status at all, 401 included, means the listener bound and the
      // wall answered. Only a refused connection is worth waiting on.
      await initialize(baseUrl);
      return;
    } catch {
      await Bun.sleep(1000);
    }
  }
  throw new Error(
    `Nothing bound ${baseUrl} within ${BIND_TIMEOUT_SECONDS}s. The instance did not start.`,
  );
}

/** A response, reduced to what a failure message needs to quote. */
async function describe(response: Response): Promise<string> {
  return `${response.status} ${(await response.text()).slice(0, 500)}`;
}

async function main(): Promise<void> {
  const port = process.env["ACP_PORT"] ?? String(DEFAULT_PORTS.editor);
  const baseUrl = process.argv[2] ?? `http://127.0.0.1:${port}`;
  const key = process.argv[3] ?? process.env["CRAFT_API_KEY"] ?? "";
  if (key === "") {
    throw new Error(
      "No credential. Pass one as the second argument or set CRAFT_API_KEY.",
    );
  }

  await waitForListener(baseUrl);

  const anonymous = await initialize(baseUrl);
  if (anonymous.status !== 401) {
    throw new Error(
      `The editor door answered a request carrying no credential: ${await describe(anonymous)}`,
    );
  }

  const authenticated = await initialize(baseUrl, {
    authorization: `Bearer ${key}`,
  });
  if (authenticated.status !== 200) {
    throw new Error(
      `The editor door refused the key: ${await describe(authenticated)}`,
    );
  }

  // A protocol error is answered with 200 and an `error` member, so checking
  // the status and grepping for a field name would both pass on a refusal.
  // The result is the only thing that says the mount is serving.
  const body = (await authenticated.json()) as {
    result?: { protocolVersion?: number };
  };
  if (typeof body.result?.protocolVersion !== "number") {
    throw new Error(
      `The editor door answered 200 without an initialize result: ${JSON.stringify(body).slice(0, 500)}`,
    );
  }

  console.log(
    `The editor door at ${baseUrl} refused an anonymous caller and answered protocol version ${body.result.protocolVersion} with the key.`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
