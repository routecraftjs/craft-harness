import { describe, expect, test } from "bun:test";
import { WorkspaceReadInput } from "../capabilities/tools/workspace-read/route.js";
import { WorkspaceWriteInput } from "../capabilities/tools/workspace-write/route.js";
import { MEMORY_ROOT, WORKSPACE_ROOT, resolveWithin } from "../shared/paths.js";

/**
 * The agent's reach over the filesystem is two folders, and the rule that
 * keeps it there.
 *
 * These are the tests that would fail if someone replaced the resolve-then-
 * compare with a string prefix check, which is the mistake this class of
 * guard is usually written with.
 */
describe("path containment", () => {
  /**
   * @case An ordinary relative path resolves inside the root
   * @preconditions A nested path with no traversal
   * @expectedResult The absolute path, under the root
   */
  test("resolves a path inside the root", () => {
    const resolved = resolveWithin(WORKSPACE_ROOT, "notes/today.md");
    expect(resolved).toBe(`${WORKSPACE_ROOT}/notes/today.md`);
  });

  /**
   * @case Traversal is refused however it is spelled
   * @preconditions Paths using .. at the start, in the middle, and repeatedly
   * @expectedResult undefined for each, because the check runs on the
   *   resolved path rather than on the text
   */
  test("refuses traversal", () => {
    for (const candidate of [
      "../env.ts",
      "notes/../../env.ts",
      "../../../../etc/passwd",
      "a/b/../../../outside.txt",
    ]) {
      expect(resolveWithin(WORKSPACE_ROOT, candidate)).toBeUndefined();
    }
  });

  /**
   * @case An absolute path is refused
   * @preconditions A path that names the filesystem root
   * @expectedResult undefined, so an absolute path cannot bypass the root by
   *   ignoring it
   */
  test("refuses an absolute path", () => {
    expect(resolveWithin(WORKSPACE_ROOT, "/etc/passwd")).toBeUndefined();
    expect(resolveWithin(WORKSPACE_ROOT, WORKSPACE_ROOT)).toBeUndefined();
  });

  /**
   * @case The root itself is not a file inside the root
   * @preconditions An empty path
   * @expectedResult undefined rather than the root directory
   */
  test("refuses the empty path", () => {
    expect(resolveWithin(WORKSPACE_ROOT, "")).toBeUndefined();
  });

  /**
   * @case The two roots do not leak into each other
   * @preconditions A path that would resolve inside memory, checked against
   *   the workspace root
   * @expectedResult Each root only admits what is under it
   */
  test("keeps the roots separate", () => {
    expect(resolveWithin(MEMORY_ROOT, "topic.md")).toBe(
      `${MEMORY_ROOT}/topic.md`,
    );
    expect(resolveWithin(WORKSPACE_ROOT, "../memory/topic.md")).toBeUndefined();
  });
});

describe("the workspace capabilities", () => {
  /**
   * @case Reads are confined to the two readable roots
   * @preconditions Paths outside workspace/ and skills/proposed/
   * @expectedResult Validation fails, so the read never runs
   */
  test("refuse a read outside the roots", () => {
    for (const path of [
      "env.ts",
      "../env.ts",
      "workspace/../env.ts",
      "/etc/passwd",
      "skills/web-research/SKILL.md",
      "workspace-secrets/keys.txt",
    ]) {
      expect(WorkspaceReadInput.safeParse({ path }).success).toBe(false);
    }
  });

  /**
   * @case Reads inside the roots are admitted
   * @preconditions Paths under workspace/ and skills/proposed/
   * @expectedResult Validation passes
   */
  test("admit a read inside the roots", () => {
    expect(
      WorkspaceReadInput.safeParse({ path: "workspace/a.md" }).success,
    ).toBe(true);
    expect(
      WorkspaceReadInput.safeParse({ path: "skills/proposed/x/SKILL.md" })
        .success,
    ).toBe(true);
  });

  /**
   * @case The agent cannot write into the loaded skills folder
   * @preconditions A path under skills/ but not under skills/proposed/
   * @expectedResult Validation fails, which is what makes a proposed skill a
   *   proposal rather than a self-granted capability
   */
  test("refuse a write into skills/", () => {
    expect(
      WorkspaceWriteInput.safeParse({
        path: "skills/new-skill/SKILL.md",
        content: "x",
      }).success,
    ).toBe(false);
    expect(
      WorkspaceWriteInput.safeParse({
        path: "skills/proposed/new-skill/SKILL.md",
        content: "x",
      }).success,
    ).toBe(true);
  });
});
