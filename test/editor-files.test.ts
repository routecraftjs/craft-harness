import { describe, expect, test } from "bun:test";
import editFile from "../capabilities/editor/edit-file/route.js";
import openUrl from "../capabilities/editor/open-url/route.js";
import readFile, {
  ReadFileInput,
} from "../capabilities/editor/read-file/route.js";
import updatePlan from "../capabilities/editor/update-plan/route.js";
import writeFile from "../capabilities/editor/write-file/route.js";
import { FILE_LINE_LIMIT } from "../shared/editor.js";
import { pathRefusal } from "../shared/editor-paths.js";
import { runWithScriptedEditor } from "./support/scripted-editor.js";

/**
 * The capabilities that reach the person's files, their browser and their
 * plan, against a scripted editor answering the protocol for real.
 *
 * The path rules are asserted twice on purpose: once as the rule, because a
 * refusal has to say which rule it broke, and once through a whole turn,
 * because a rule enforced in `.input()` is only a boundary if a refused path
 * never becomes a protocol call.
 */
describe("the editor's files", () => {
  const routes = [readFile, writeFile, editFile, openUrl, updatePlan];

  /**
   * @case A path outside the project, a dotfile and `.env` are each refused
   *   with the rule they broke
   * @preconditions The rule alone, with no editor involved
   * @expectedResult A message naming the rule. The project boundary itself
   *   is the editor's to enforce, and these are the rules it will not
   *   enforce for us: traversal, dotfiles, and the file that holds this
   *   instance's own credentials.
   */
  test("refuses traversal, dotfiles and .env, naming the rule", () => {
    expect(pathRefusal("/project/../etc/passwd")).toContain("walks up");
    expect(pathRefusal("/project/.env")).toContain("dotfiles");
    expect(pathRefusal("/project/.git/config")).toContain("dotfiles");
    expect(pathRefusal("relative/path.ts")).toContain("absolute");
    expect(pathRefusal("/project/src/index.ts")).toBeUndefined();
  });

  /**
   * @case A refused path never reaches the editor
   * @preconditions A turn asking to read `.env` in the open project
   * @expectedResult No `fs/read_text_file` call at all. A rule that refused
   *   after asking would still have asked, and the editor would still have
   *   opened the file.
   */
  test("a refused path makes no protocol call", async () => {
    const run = await runWithScriptedEditor({
      routes,
      route: "read-file",
      input: { path: "/project/.env" },
    });

    expect(run.callsTo("fs/read_text_file")).toHaveLength(0);
    // Refused by the schema, before the route runs at all, so the model is
    // told which rule it broke rather than that something went wrong.
    expect(run.modelSaw).toContain("dotfiles");
  });

  /**
   * @case The schema is where the refusal happens
   * @preconditions The route's own input schema
   * @expectedResult Parsing fails, so the guardrail is the type rather than
   *   a check somebody could forget to call
   */
  test("the schema itself refuses a dotfile", () => {
    expect(ReadFileInput.safeParse({ path: "/p/.env" }).success).toBe(false);
    expect(ReadFileInput.safeParse({ path: "/p/ok.ts" }).success).toBe(true);
  });

  /**
   * @case Reading asks the editor and answers with the file
   * @preconditions An editor holding the file
   * @expectedResult The content comes back, and the editor was asked for the
   *   path the agent named
   */
  test("reads a file through the editor", async () => {
    const run = await runWithScriptedEditor({
      routes,
      route: "read-file",
      input: { path: "/project/notes.md" },
      editorFiles: { "/project/notes.md": "the contents" },
    });

    expect(run.callsTo("fs/read_text_file")[0]?.params["path"]).toBe(
      "/project/notes.md",
    );
    expect(run.toolOutput?.["content"]).toBe("the contents");
  });

  /**
   * @case A big file is bounded at the editor, not after it arrives
   * @preconditions A file longer than the harness will take
   * @expectedResult The read carried a line limit, and the file is refused
   *   rather than answered short. Asking for the bound is what stops a
   *   gigabyte being read, serialised, sent and buffered here only to be
   *   turned down; refusing rather than truncating is what stops a model
   *   reasoning about a file it thinks it read. The editor is shown the
   *   same reason the model is, not just the error class.
   */
  test("a file over the line limit is refused, and the limit was asked for", async () => {
    const run = await runWithScriptedEditor({
      routes,
      route: "read-file",
      input: { path: "/project/big.log" },
      editorFiles: {
        "/project/big.log": Array.from(
          { length: FILE_LINE_LIMIT + 500 },
          (_unused, line) => `line ${line}`,
        ).join("\n"),
      },
    });

    expect(run.callsTo("fs/read_text_file")[0]?.params["limit"]).toBe(
      FILE_LINE_LIMIT + 1,
    );
    expect(run.toolFailed).toBe(true);
    expect(run.modelSaw).toContain("longer than");
    expect(run.toolText).toContain("longer than");
  });

  /**
   * @case A write asks first, and a refusal writes nothing
   * @preconditions An editor that says no
   * @expectedResult The person was asked and no write happened. There is no
   *   allowlist of files it is fine to overwrite unannounced: it is their
   *   project, open in front of them.
   */
  test("a refused write leaves the file alone", async () => {
    const run = await runWithScriptedEditor({
      routes,
      route: "write-file",
      input: { path: "/project/notes.md", content: "new" },
      editorFiles: { "/project/notes.md": "old" },
      permission: () => ({ outcome: "cancelled" }),
    });

    expect(run.callsTo("session/request_permission")).toHaveLength(1);
    expect(run.callsTo("fs/write_text_file")).toHaveLength(0);
    expect(run.editorFiles["/project/notes.md"]).toBe("old");
    expect(run.toolOutput?.["refused"]).toBeDefined();
  });

  /**
   * @case An allowed write reaches the editor
   * @preconditions An editor that says yes
   * @expectedResult The file holds the new content
   */
  test("an allowed write reaches the editor", async () => {
    const run = await runWithScriptedEditor({
      routes,
      route: "write-file",
      input: { path: "/project/notes.md", content: "new" },
      editorFiles: { "/project/notes.md": "old" },
    });

    expect(run.written["/project/notes.md"]).toBe("new");
  });

  /**
   * @case An edit carries its diff on the question itself
   * @preconditions A file with the text to replace in it
   * @expectedResult The permission request carries diff content with the old
   *   and new text, so JetBrains renders the change in the same object as the
   *   question and the person answers while looking at it.
   *
   *   On the request rather than as a separate `tool_call_update`: an update
   *   has to name a tool call id, this route cannot reach the one the adapter
   *   assigned, and a client handed an id it has never seen is free to drop
   *   the update. That would leave the person answering "apply the change"
   *   having been shown nothing, with nothing here able to notice.
   */
  test("an edit asks with the diff attached, then writes", async () => {
    const run = await runWithScriptedEditor({
      routes,
      route: "edit-file",
      input: {
        path: "/project/a.ts",
        find: "const a = 1;",
        replace: "const a = 2;",
      },
      editorFiles: { "/project/a.ts": "const a = 1;\nconst b = 3;\n" },
    });

    const ask = run.callsTo("session/request_permission")[0];
    const diff = (
      (ask?.params["toolCall"] as { content?: Array<Record<string, unknown>> })
        ?.content ?? []
    ).find((block) => block["type"] === "diff");

    expect(diff).toMatchObject({
      path: "/project/a.ts",
      oldText: "const a = 1;\nconst b = 3;\n",
      newText: "const a = 2;\nconst b = 3;\n",
    });
    expect(run.written["/project/a.ts"]).toBe("const a = 2;\nconst b = 3;\n");
  });

  /**
   * @case A file changed while the person was answering is not reverted
   * @preconditions The file edited under the prompt, which is where the
   *   person is: they are sitting in this editor with this file open, and
   *   the gap is however long they take to read the diff
   * @expectedResult The write never happens and the model is told why. The
   *   route computes the whole new file from a read taken BEFORE the
   *   question, so writing it afterwards would revert their typing, their
   *   formatter, or a checkout in another pane, silently, on a click that
   *   meant "yes, that diff".
   */
  test("an edit refuses when the file changed under the prompt", async () => {
    const run = await runWithScriptedEditor({
      routes,
      route: "edit-file",
      input: {
        path: "/project/a.ts",
        find: "const a = 1;",
        replace: "const a = 2;",
      },
      editorFiles: { "/project/a.ts": "const a = 1;\nconst b = 3;\n" },
      permission: (_params, editorFiles) => {
        editorFiles["/project/a.ts"] = "const a = 1;\nconst b = 4;\n";
        return { outcome: "selected", optionId: "allow" };
      },
    });

    expect(run.callsTo("fs/write_text_file")).toHaveLength(0);
    expect(run.editorFiles["/project/a.ts"]).toBe(
      "const a = 1;\nconst b = 4;\n",
    );
    expect(run.toolFailed).toBe(true);
    expect(run.modelSaw).toContain("changed while you were being asked");
  });

  /**
   * @case Text that appears twice is refused rather than half-applied
   * @preconditions A file where the target appears twice
   * @expectedResult A failed call and no write. Replacing the first would
   *   change something the model never looked at.
   */
  test("an edit matching twice refuses and writes nothing", async () => {
    const run = await runWithScriptedEditor({
      routes,
      route: "edit-file",
      input: { path: "/project/a.ts", find: "x", replace: "y" },
      editorFiles: { "/project/a.ts": "x and x" },
    });

    expect(run.toolFailed).toBe(true);
    expect(run.modelSaw).toContain("more than once");
    expect(run.callsTo("fs/write_text_file")).toHaveLength(0);
  });

  /**
   * @case Text that is not there is refused, and says why
   * @preconditions A file that no longer contains the target
   * @expectedResult A failed call telling the model its read is stale, which
   *   is the actual cause almost every time
   */
  test("an edit matching nothing says the read is stale", async () => {
    const run = await runWithScriptedEditor({
      routes,
      route: "edit-file",
      input: { path: "/project/a.ts", find: "gone", replace: "y" },
      editorFiles: { "/project/a.ts": "something else" },
    });

    expect(run.toolFailed).toBe(true);
    expect(run.modelSaw).toContain("not in the file");
  });

  /**
   * @case A link is opened through the editor's URL elicitation
   * @preconditions An editor that accepts the elicitation
   * @expectedResult The editor received the url and the call reports it
   *   opened
   */
  test("opens a link through the editor", async () => {
    const run = await runWithScriptedEditor({
      routes,
      route: "open-url",
      input: { url: "https://routecraft.dev/docs/introduction" },
    });

    expect(run.callsTo("elicitation/create")[0]?.params["url"]).toBe(
      "https://routecraft.dev/docs/introduction",
    );
    expect(run.toolOutput?.["opened"]).toBe(true);
  });

  /**
   * @case A scheme other than http or https is refused
   * @preconditions The route's own input schema
   * @expectedResult Refused before anything is asked. A `file:` link would
   *   ask the person's browser to open something on their disk that a model
   *   chose.
   */
  test("refuses a link that is not http or https", async () => {
    const run = await runWithScriptedEditor({
      routes,
      route: "open-url",
      input: { url: "file:///etc/passwd" },
    });

    expect(run.callsTo("elicitation/create")).toHaveLength(0);
    expect(run.modelSaw.toLowerCase()).toContain("url");
  });

  /**
   * @case The plan reaches the editor as a plan
   * @preconditions Three steps, one of them finished
   * @expectedResult A `plan` session update carrying every entry. The
   *   protocol replaces the whole plan on each update, so every step is sent
   *   each time rather than only the one that changed.
   */
  test("shows the plan in the editor", async () => {
    const run = await runWithScriptedEditor({
      routes,
      route: "update-plan",
      input: {
        entries: [
          { content: "Read the code", priority: "high", status: "completed" },
          { content: "Write the fix", priority: "high", status: "in_progress" },
          { content: "Run the tests", priority: "medium", status: "pending" },
        ],
      },
    });

    const plan = run.calls.find(
      (call) =>
        call.method === "session/update" &&
        (call.params as { update?: { sessionUpdate?: string } }).update
          ?.sessionUpdate === "plan",
    );

    expect(plan).toBeDefined();
    expect(JSON.stringify(plan)).toContain("Write the fix");
    expect(run.toolOutput).toMatchObject({ shown: 3, done: 1 });
  });
});
