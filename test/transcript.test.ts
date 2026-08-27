import { describe, expect, test } from "bun:test";
import {
  SessionId,
  parseTurns,
  renderPrompt,
  transcriptFile,
  turn,
} from "../shared/transcript.js";
import { STATE_ROOT } from "../shared/paths.js";

/**
 * The conversation on disk, and the prompt built from it.
 */
describe("transcripts", () => {
  /**
   * @case A session id cannot escape the transcripts folder
   * @preconditions Ids containing separators and traversal
   * @expectedResult Rejected by the schema, so the id can be used as a
   *   filename without sanitising it afterwards
   */
  test("refuse a session id that is not filename-safe", () => {
    for (const id of ["../secret", "a/b", "", "a b", "x".repeat(65)]) {
      expect(SessionId.safeParse(id).success).toBe(false);
    }
    expect(SessionId.safeParse("demo-1.2_3").success).toBe(true);
  });

  /**
   * @case A valid id resolves inside the transcripts folder
   * @preconditions An accepted session id
   * @expectedResult A path under state/transcripts
   */
  test("resolve a transcript inside state", () => {
    expect(transcriptFile("demo")).toBe(`${STATE_ROOT}/transcripts/demo.jsonl`);
  });

  /**
   * @case Unreadable lines are skipped, not fatal
   * @preconditions A file holding one good turn and three unusable lines
   * @expectedResult Only the good turn survives, so one corrupt line cannot
   *   strand a person mid-conversation
   */
  test("keep only the lines that parse", () => {
    const good = turn("user", "hello");
    expect(
      parseTurns([good, null, "nonsense", { role: "wizard", at: "x" }]),
    ).toEqual([good]);
  });

  /**
   * @case A first message renders as itself
   * @preconditions No prior turns
   * @expectedResult The message alone, with no empty history heading
   */
  test("render a first message with no history", () => {
    expect(renderPrompt([], "hello")).toBe("hello");
  });

  /**
   * @case History is separated from the message being asked now
   * @preconditions One prior turn
   * @expectedResult Both appear under headings, so the model can tell what it
   *   is being asked from what it is being reminded of
   */
  test("render history and the new message apart", () => {
    const rendered = renderPrompt([turn("user", "earlier")], "now");
    expect(rendered).toContain("# Conversation so far");
    expect(rendered).toContain("earlier");
    expect(rendered).toContain("# Message\n\nnow");
  });
});
