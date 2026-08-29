/**
 * The environment every test runs under: a fresh scaffold, pinned.
 *
 * Two reasons this file assigns rather than defaults. The obvious one is
 * that `env.ts` parses at import, so the required variables have to exist
 * before the first module that reads them loads.
 *
 * The load-bearing one is that Bun loads `.env` for `bun test` too, and a
 * developer running the suite has a real `.env` with their own key, their
 * own allowlist, and possibly a mailbox. Half this suite asserts what a
 * scaffold does BEFORE any of that is configured ("reaches nothing",
 * "nobody can approve", "mail is dormant"), and a machine-local `.env`
 * would quietly turn those assertions into assertions about that machine.
 * So the values below overwrite rather than defer: the suite constructs the
 * starting state it claims to describe.
 *
 * Configure a variable HERE, per test, if a test needs it set. Do not reach
 * for the ambient environment.
 */

/** Required to parse, and deliberately not usable against anything real. */
process.env["NODE_ENV"] = "test";
process.env["LLM_API_KEY"] = "test-key-not-a-real-one";
process.env["CRAFT_API_KEY"] = "test-api-key-at-least-thirty-two-chars";
process.env["ROUTECRAFT_SUSPENSION_SECRET"] =
  "test-secret-at-least-thirty-two-bytes-long";

/**
 * Everything a fresh scaffold has NOT configured. Emptied rather than
 * deleted: `env.ts` reads an empty string as unset for each of these, and an
 * explicit empty value is visible here as a decision.
 */
process.env["WEB_FETCH_ALLOWED_HOSTS"] = "";
process.env["BRAVE_SEARCH_API_KEY"] = "";
process.env["APPROVERS"] = "";
process.env["MAIL_ADDRESS"] = "";
process.env["MAIL_APP_PASSWORD"] = "";
process.env["HEARTBEAT_ENABLED"] = "false";
