import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The four directories the harness writes to, and the containment rule that
 * keeps a path inside one of them.
 *
 * Every path the agent supplies is relative to one of these roots. The check
 * is applied by each capability's own `.input()` schema rather than inside a
 * file helper, so the boundary is visible in the route that enforces it.
 */

/** Files the agent may read and write freely. Its desk. */
export const WORKSPACE_ROOT = resolve("workspace");

/** Plain-text notes the agent saves and recalls. */
export const MEMORY_ROOT = resolve("memory");

/** Runtime state the harness owns: chat transcripts and the schedule file. */
export const STATE_ROOT = resolve("state");

/**
 * Where the agent drafts skills. Never `skills/` itself: a skill the agent
 * wrote is a proposal until a human moves it, and nothing here is loaded.
 */
export const PROPOSED_SKILLS_ROOT = resolve("skills", "proposed");

/**
 * Resolve a caller-supplied relative path inside `root`, or return
 * `undefined` when it escapes.
 *
 * Resolving first and comparing after is what makes this sound: `..`,
 * a symlink-free absolute path, and a path that merely starts with the
 * root's name (`workspace-secrets/x`) are all caught by the same comparison,
 * where a string prefix test lets the third through.
 *
 * It does NOT resolve symlinks. A symlink already inside the root that
 * points outside it is followed by the eventual read or write. The roots are
 * the harness's own directories, so putting one there is a deliberate act by
 * whoever owns the project.
 *
 * @param root - Absolute root the path must stay inside
 * @param candidate - Relative path from the model or the caller
 * @returns The absolute path, or `undefined` when it escapes the root
 */
export function resolveWithin(
  root: string,
  candidate: string,
): string | undefined {
  if (candidate === "" || isAbsolute(candidate)) return undefined;
  const absolute = resolve(join(root, candidate));
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return absolute;
}

/** The single file every scheduled task is appended to, one task per line. */
export const SCHEDULES_FILE = join(STATE_ROOT, "schedules.jsonl");

/** Display form of a path, relative to the project root. */
export function displayPath(absolute: string): string {
  const rel = relative(resolve("."), absolute);
  return rel.startsWith("..") ? absolute : rel.split(sep).join("/");
}
