/**
 * Generate this project's own credentials, once.
 *
 * Two secrets have no sensible default and cannot be committed: the API key
 * that secures every surface the harness exposes, and the secret the
 * suspension store signs resume links with. This script generates both and
 * writes them where they are read from: `.env` for the process, and
 * `.routecraft/settings.yaml` for the CLI, so `craft exec` works with no
 * flags immediately.
 *
 * It runs from `bun run setup`, not from install and not from boot. A
 * framework that generated a credential the first time an app started would
 * be minting, and a harness that minted on install would put a secret on
 * disk before anyone had decided to run it. This is one explicit command,
 * and it says what it wrote.
 *
 * Idempotent in the way that matters: an existing value is never replaced.
 * Run it after a fresh clone (which has neither file) and it fills both in;
 * run it again and it only fills what is missing. Rotating is deleting the
 * lines and running it again, which is a thing you can mean rather than a
 * thing that happens to you.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ENV_FILE = join(ROOT, ".env");
const SETTINGS_FILE = join(ROOT, ".routecraft", "settings.yaml");

/**
 * 32 bytes of randomness, URL-safe.
 *
 * Base64url rather than hex so the key stays short enough to paste, and
 * without `+`, `/` or `=`, which would need quoting in a YAML scalar and a
 * shell argument. 32 bytes is 256 bits: a bearer credential on a listening
 * port is guessed offline, so the length is the whole defence.
 */
function generateSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Where `craft` actually is, as an absolute path, or `undefined`.
 *
 * JetBrains launches the editor entry's command directly rather than through
 * a shell, so it inherits no PATH a developer set in their profile and a
 * bare `craft` resolves to nothing. The binary the project installed is the
 * one this entry should reach anyway: an editor pointed at whatever `craft`
 * a machine happens to have on PATH is an editor that talks to a different
 * version of the CLI than the repository pins.
 */
function findCraft(): string | undefined {
  const local = join(ROOT, "node_modules", ".bin", "craft");
  if (existsSync(local)) return local;
  for (const entry of (process.env["PATH"] ?? "").split(delimiter)) {
    if (entry === "") continue;
    const candidate = resolve(entry, "craft");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Values already present in `.env`, by name. */
function parseEnvFile(contents: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of contents.split("\n")) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=(.*)$/.exec(line);
    if (match) values.set(match[1]!, match[2]!.trim());
  }
  return values;
}

/** The variables setup owns, and how to produce one when it is missing. */
const GENERATED = [
  {
    name: "CRAFT_API_KEY",
    note: "secures the approval, MCP, editor and ops surfaces",
  },
  {
    name: "ROUTECRAFT_SUSPENSION_SECRET",
    note: "signs the single-use links that resolve an approval",
  },
] as const;

/**
 * Variables a person must supply. Written as empty lines with a comment so
 * `.env` shows what is still missing, rather than being silently absent and
 * failing at boot with no hint of where the value belongs.
 */
const REQUIRED_BY_HAND = [
  { name: "LLM_API_KEY", note: "your model provider's key" },
] as const;

/**
 * The whole of `.routecraft/settings.yaml`, rendered from what `.env` holds.
 *
 * Two addresses, because they are two surfaces: the bare keys are the ops
 * door `craft exec` and `craft ops` talk to, and the `editor` profile is the
 * ACP mount an editor connects to. `craft acp` appends `/acp` to whichever
 * url it resolved and sends `agent` as a header, so naming aria here is what
 * makes the first prompt from an editor arrive as Aria.
 */
function renderSettings(
  apiKey: string,
  opsPort: string,
  acpPort: string,
): string {
  return [
    "# Written by bun run setup. Gitignored: it carries a credential.",
    "# `craft exec` and `craft ops` read this, so neither needs a flag.",
    `url: http://127.0.0.1:${opsPort}`,
    `token: ${apiKey}`,
    "",
    "# What `craft acp --profile editor` selects: the editor door, the same",
    "# credential, and the agent an editor conversation is answered by.",
    "profiles:",
    "  editor:",
    `    url: http://127.0.0.1:${acpPort}`,
    `    token: ${apiKey}`,
    "    agent: aria",
    "",
  ].join("\n");
}

/**
 * The lines a person pastes into their editor, or the reason there are none.
 *
 * Printed rather than written into an editor's own configuration: those live
 * outside the repository, differ per install, and are not setup's to edit.
 */
function editorEntry(): string[] {
  const craft = findCraft();
  if (craft === undefined) {
    return [
      "",
      "Editor entry: could not find the `craft` binary.",
      "  Run `bun install`, then run setup again.",
    ];
  }
  return [
    "",
    "Talk to Aria from your editor. Command, arguments, and no shell:",
    `  command: ${craft}`,
    "  arguments: acp --profile editor",
    "",
    "  JetBrains: Settings, Tools, AI Assistant, Agent Client Protocol,",
    "  add an agent with that command and those arguments.",
    "  Zed: agent_servers in settings.json, with the same two.",
    "  Both need `bun run dev` running. See HELP.md.",
  ];
}

async function main(): Promise<void> {
  const existing = existsSync(ENV_FILE)
    ? parseEnvFile(await readFile(ENV_FILE, "utf8"))
    : new Map<string, string>();

  const generated: string[] = [];
  const blanked: string[] = [];
  const lines: string[] = [];

  if (!existing.has("NODE_ENV")) {
    lines.push(
      "# Development mode: the MCP transport requires an HTTPS MCP_URL outside it.",
      "NODE_ENV=development",
      "",
    );
  }

  for (const { name, note } of GENERATED) {
    // A present-but-empty value is what deleting a key by blanking it leaves
    // behind. Refilling the line in place is what keeps a rotation from
    // appending a second declaration of the same variable.
    if (existing.get(name)) continue;
    if (existing.has(name)) {
      blanked.push(name);
      continue;
    }
    lines.push(
      `# Generated by bun run setup: ${note}.`,
      `${name}=${generateSecret()}`,
      "",
    );
    generated.push(name);
  }

  for (const { name, note } of REQUIRED_BY_HAND) {
    if (existing.has(name)) continue;
    lines.push(`# Set this by hand: ${note}.`, `${name}=`, "");
  }

  let body = existsSync(ENV_FILE) ? await readFile(ENV_FILE, "utf8") : "";
  for (const name of blanked) {
    body = body.replace(
      new RegExp(`^${name}=\\s*$`, "m"),
      `${name}=${generateSecret()}`,
    );
    generated.push(name);
  }
  if (lines.length > 0 || blanked.length > 0) {
    const separator = body === "" || body.endsWith("\n") ? "" : "\n";
    await writeFile(ENV_FILE, body + separator + lines.join("\n"), {
      mode: 0o600,
    });
    // mode applies on creation only, so an existing file needs telling.
    await chmod(ENV_FILE, 0o600);
  }

  // Read back rather than reusing the value in hand: on a second run the key
  // came from the file, and the settings file must carry whatever `.env`
  // actually holds rather than something this run happened to generate.
  const finalEnv = parseEnvFile(await readFile(ENV_FILE, "utf8"));
  const apiKey = finalEnv.get("CRAFT_API_KEY") ?? "";
  const opsPort = finalEnv.get("OPS_PORT") ?? "9090";
  const acpPort = finalEnv.get("ACP_PORT") ?? "8082";

  const wanted = renderSettings(apiKey, opsPort, acpPort);
  const settings = existsSync(SETTINGS_FILE)
    ? await readFile(SETTINGS_FILE, "utf8")
    : "";
  if (settings === wanted) {
    console.log(`Kept   ${rel(SETTINGS_FILE)} (already matches .env)`);
  } else {
    // Rewritten rather than merged, and that is the ownership model rather
    // than a shortcut: the documented rotation deletes the token from both
    // files, which leaves this one present but carrying a key .env no longer
    // has, and keeping it would answer 401 and blame the caller. This file is
    // setup's to write; a personal profile belongs in the global settings
    // file under your home directory, which setup never touches.
    await mkdir(dirname(SETTINGS_FILE), { recursive: true, mode: 0o700 });
    await writeFile(SETTINGS_FILE, wanted, { mode: 0o600 });
    await chmod(SETTINGS_FILE, 0o600);
    console.log(
      `Wrote  ${rel(SETTINGS_FILE)} (ops url, token, editor profile)`,
    );
  }

  for (const name of generated) console.log(`Wrote  .env ${name}`);
  for (const { name } of GENERATED) {
    if (!generated.includes(name))
      console.log(`Kept   .env ${name} (already set)`);
  }

  const missing = REQUIRED_BY_HAND.filter(
    ({ name }) => (finalEnv.get(name) ?? "") === "",
  );
  if (missing.length > 0) {
    console.log(
      `\nStill needed, by hand in .env: ${missing.map((m) => m.name).join(", ")}.`,
    );
  }
  console.log("\nThen: bun run dev");
  for (const line of editorEntry()) console.log(line);
}

function rel(path: string): string {
  return path.slice(ROOT.length + 1);
}

await main();
