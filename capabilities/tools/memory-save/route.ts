import { craft, direct, file } from "@routecraft/routecraft";
import { z } from "zod";
import { MEMORY_ROOT, resolveWithin } from "../../../shared/paths.js";

/**
 * Save something worth remembering.
 *
 * Memory here is a folder of plain text files, one per topic, and that is
 * the whole design. No embeddings, no vector store, no index: recall is a
 * search over files a person can open, edit and delete, and being able to
 * read what the agent thinks it knows is worth more in a harness than
 * semantic recall over an opaque store.
 *
 * Nothing is injected automatically. The agent recalls when it decides the
 * conversation needs it, which keeps what is in its context something it
 * chose rather than something a retriever guessed at.
 */

/**
 * Header carrying which topic is being written.
 *
 * The file destination writes whatever the body is, so the body has to
 * become the line before the write. The topic is envelope from that point
 * on, and the destination path is derived from it.
 */
const TOPIC_HEADER = "harness.memory.topic";

export const MemorySaveInput = z.object({
  topic: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, "Use letters, digits, dot, dash or underscore.")
    .describe("What this note is about. One file per topic."),
  note: z.string().min(1).describe("What to remember, in plain words."),
});
export type MemorySaveInput = z.infer<typeof MemorySaveInput>;

/** Where a topic's notes live. Never outside `memory/`. */
function memoryFile(topic: string): string {
  const path = resolveWithin(MEMORY_ROOT, `${topic}.md`);
  if (path === undefined) {
    throw new Error(`Topic "${topic}" does not resolve inside memory/.`);
  }
  return path;
}

export default craft()
  .id("memory-save")
  .description("Save a note to long-term memory under a topic.")
  .input({ body: MemorySaveInput })
  .from<MemorySaveInput>(direct())
  .header(TOPIC_HEADER, (exchange) => exchange.body.topic)
  .transform((body) => `- [${new Date().toISOString()}] ${body.note.trim()}\n`)
  // Appended, never replaced: memory that a later save can silently
  // overwrite is memory nobody can trust, and a person pruning the file is
  // the intended way to forget something.
  // `.to()`, never `.tap()`. A tap is detached by contract, so the route would
  // answer `saved: true` before the append had happened and a failed write
  // would reach nobody: the agent has already told someone the note is kept.
  .to(
    file({
      path: (exchange) => memoryFile(String(exchange.headers[TOPIC_HEADER])),
      append: true,
      createDirs: true,
    }),
  )
  .transform((_line, exchange) => ({
    topic: String(exchange.headers[TOPIC_HEADER]),
    saved: true,
  }));
