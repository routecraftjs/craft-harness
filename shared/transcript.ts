import type { Exchange } from "@routecraft/routecraft";
import { z } from "zod";
import { STATE_ROOT, resolveWithin } from "./paths.js";

/**
 * The chat transcript: what a session remembers between messages.
 *
 * One JSON Lines file per session, one line per turn, owned by the `chat`
 * capability and rewritten by `compact`. Lines rather than a document
 * because a conversation only ever grows at the end, and an append is the
 * one write that cannot lose the turns already in the file.
 *
 * It is deliberately NOT the agent's own model thread. A model thread
 * carries tool calls and provider-specific parts and lives and dies with one
 * dispatch; this is the conversation a person would recognise.
 */

/** One turn of a conversation. */
export const TranscriptTurn = z.object({
  role: z.enum(["user", "assistant"]),
  at: z.iso.datetime(),
  text: z.string(),
});
export type TranscriptTurn = z.infer<typeof TranscriptTurn>;

/**
 * Session ids the harness accepts.
 *
 * The id becomes a filename, so it is constrained to what cannot escape the
 * transcripts folder rather than sanitised after the fact. Every capability
 * that takes a session reuses this schema, so there is one rule.
 */
export const SessionId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, "Use letters, digits, dot, dash or underscore.");

/**
 * Header carrying which conversation an exchange belongs to.
 *
 * On a header rather than the body because the body is rewritten several
 * times on the way through `chat` (the turns, then the prompt, then the
 * model's answer) while the file being read and appended to stays the same
 * one. That is the envelope-versus-payload split the exchange state model
 * describes.
 */
export const SESSION_HEADER = "harness.chat.session";

/** The session an exchange belongs to, or `""` when it carries none. */
export function sessionOf(exchange: Exchange<unknown>): string {
  const value = exchange.headers[SESSION_HEADER];
  return typeof value === "string" ? value : "";
}

/**
 * Where a session's transcript lives.
 *
 * Throws rather than falling back: every caller has already put the id
 * through {@link SessionId}, so a path that will not resolve inside
 * `state/transcripts` means the containment rule and the schema have drifted
 * apart, and writing somewhere else is the worst possible response to that.
 */
export function transcriptFile(session: string): string {
  const path = resolveWithin(STATE_ROOT, `transcripts/${session}.jsonl`);
  if (path === undefined) {
    throw new Error(`Session "${session}" does not resolve inside state/.`);
  }
  return path;
}

/** The transcript file of whichever session the exchange belongs to. */
export function transcriptFileOf(exchange: Exchange<unknown>): string {
  return transcriptFile(sessionOf(exchange));
}

/**
 * Keep the turns a transcript file actually parses as, dropping the rest.
 *
 * A line the schema rejects is skipped rather than failing the exchange.
 * Refusing to answer because one old line will not parse strands the person
 * mid-conversation, and every line this harness writes is written in the
 * shape the schema declares.
 */
export function parseTurns(lines: readonly unknown[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const line of lines) {
    const parsed = TranscriptTurn.safeParse(line);
    if (parsed.success) turns.push(parsed.data);
  }
  return turns;
}

/**
 * Render a conversation as the user prompt for the next dispatch.
 *
 * The prior turns are labelled and dated, then the message being asked now
 * is set apart under its own heading, so the model can tell what it is being
 * asked from what it is being reminded of. A first message renders as just
 * itself.
 *
 * @param turns - Prior turns, oldest first
 * @param message - The message being asked now
 */
export function renderPrompt(
  turns: readonly TranscriptTurn[],
  message: string,
): string {
  if (turns.length === 0) return message;
  const history = turns
    .map((turn) => `[${turn.at}] ${turn.role}: ${turn.text}`)
    .join("\n");
  return `# Conversation so far\n\n${history}\n\n# Message\n\n${message}`;
}

/** A turn stamped with the moment it was recorded. */
export function turn(
  role: TranscriptTurn["role"],
  text: string,
): TranscriptTurn {
  return { role, at: new Date().toISOString(), text };
}
