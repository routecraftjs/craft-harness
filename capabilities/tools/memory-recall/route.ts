import {
  type DirectoryEntry,
  craft,
  direct,
  directory,
  only,
} from "@routecraft/routecraft";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { MEMORY_ROOT } from "../../../shared/paths.js";

/**
 * Look through what has been remembered.
 *
 * A substring search over the memory folder. It is not clever and does not
 * try to be: the files are short, a person wrote or reviewed most of them,
 * and a match the agent can trace back to a line in a file it can open beats
 * a similarity score it cannot argue with.
 *
 * Recall is a tool the agent calls, not something injected into every
 * prompt. What ends up in its context is what it decided it needed.
 *
 * The listing comes from the directory adapter; the matching lines are read
 * inside one step rather than by splitting the listing into an exchange per
 * file. A search is one operation over a set of files, and the split form
 * would trade that for N exchanges plus an aggregate whose only job is to
 * put them back together.
 */

export const MemoryRecallInput = z.object({
  query: z
    .string()
    .min(1)
    .describe("Words to look for. Matched case-insensitively."),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("Most matching lines to return."),
});
export type MemoryRecallInput = z.infer<typeof MemoryRecallInput>;

/** One remembered line and where it came from. */
export interface RecalledLine {
  topic: string;
  line: string;
}

export default craft()
  .id("memory-recall")
  .description("Search long-term memory for anything matching a query.")
  .input({ body: MemoryRecallInput })
  .from<MemoryRecallInput>(direct())
  .enrich(
    directory({ path: MEMORY_ROOT, recursive: true }),
    only((entries: DirectoryEntry[]) => entries, "entries"),
  )
  .transform(async (body) => {
    const needle = body.query.toLowerCase();
    const hits: RecalledLine[] = [];
    for (const entry of body.entries) {
      if (entry.ext !== ".md") continue;
      const content = await readFile(entry.path, "utf8").catch(() => "");
      for (const line of content.split("\n")) {
        if (!line.toLowerCase().includes(needle)) continue;
        hits.push({
          topic: entry.name.replace(/\.md$/, ""),
          line: line.trim(),
        });
        if (hits.length >= body.limit) break;
      }
      if (hits.length >= body.limit) break;
    }
    return { query: body.query, hits };
  });
