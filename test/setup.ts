/**
 * The environment every test runs under.
 *
 * `env.ts` parses at import, so the required variables have to exist before
 * the first module that reads them loads. Preloaded from `bunfig.toml` so no
 * test file has to remember.
 *
 * The values are deliberately the SHAPE of a fresh scaffold: a model key that
 * would not work, an empty web allowlist, no search key, no mailbox. That is
 * what makes "a fresh scaffold refuses to reach the network" something the
 * suite actually asserts rather than something the README claims.
 */
process.env["NODE_ENV"] ??= "test";
process.env["LLM_API_KEY"] ??= "test-key-not-a-real-one";
process.env["ROUTECRAFT_SUSPENSION_SECRET"] ??=
  "test-secret-at-least-thirty-two-bytes-long";
