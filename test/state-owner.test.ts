import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { testContext, type TestContext } from "@routecraft/testing";
import { SCHEDULES_FILE, WORKSPACE_ROOT } from "../shared/paths.js";
import { join } from "node:path";
import workspaceWrite from "../capabilities/tools/workspace-write/route.js";
import cancelSchedule from "../capabilities/scheduling/cancel-schedule/route.js";
import listSchedules from "../capabilities/scheduling/list-schedules/route.js";
import scheduleTask from "../capabilities/scheduling/schedule-task/route.js";
import schedulesOwner from "../capabilities/scheduling/schedules-owner/route.js";
import transcriptOwner from "../capabilities/chat/transcript-owner/route.js";
import { applyScheduleOp } from "../shared/schedule.js";
import {
  applyTranscriptOp,
  transcriptFile,
  turn,
} from "../shared/transcript.js";

const at = "2026-08-27T12:00:00.000Z";
const task = {
  id: "one",
  dueAt: at,
  task: "say hello",
  session: "demo",
  createdAt: "2026-08-27T11:00:00.000Z",
};

/**
 * What one operation decides, before anything is written.
 *
 * These are the whole decision: the owner routes are a lock, a read, this
 * function and a write. Testing the decision here leaves the route tests free
 * to be about the lock, which is the part a pure function cannot show.
 */
describe("state operations", () => {
  /**
   * @case A tick takes what is due and leaves the rest
   * @preconditions One task due and one not, against a fixed now
   * @expectedResult The due one comes back to be fired and the file keeps the
   *   other, which is what makes taking and writing back one operation
   */
  test("take the due tasks and keep the rest", () => {
    const later = { ...task, id: "two", dueAt: "2099-01-01T00:00:00.000Z" };
    const outcome = applyScheduleOp(
      { op: "takeDue", now: "2026-08-27T13:00:00.000Z" },
      [task, later],
    );
    expect(outcome.due.map((t) => t.id)).toEqual(["one"]);
    expect(outcome.tasks.map((task) => task.id)).toEqual(["two"]);
  });

  /**
   * @case Cancelling an id that is not there is not an error
   * @preconditions A file holding one task, cancelling a different id
   * @expectedResult Reported as not cancelled, and the file is unchanged. The
   *   caller wanted it gone and it is gone; failing only teaches an agent to
   *   retry a cancellation.
   */
  test("report a cancellation that matched nothing", () => {
    const outcome = applyScheduleOp({ op: "cancel", id: "absent" }, [task]);
    expect(outcome.cancelled).toBe(false);
    expect(outcome.tasks.map((task) => task.id)).toEqual(["one"]);
  });

  /**
   * @case A read changes nothing
   * @preconditions A list against a file holding one task the schema accepts
   *   and one line it does not
   * @expectedResult Reported as not written. Answering a query by writing back
   *   what the parse produced would erase the rejected line permanently, with
   *   no error, which is the loss the recovery in front of every read exists
   *   to prevent.
   */
  test("report a read as changing nothing", () => {
    const outcome = applyScheduleOp({ op: "list" }, [task, { junk: true }]);
    expect(outcome.written).toBe(false);
    expect(outcome.tasks.map((entry) => entry.id)).toEqual(["one"]);
  });

  /**
   * @case An add names the task it created
   * @preconditions An add against a file that already holds one task
   * @expectedResult The created task comes back named. Recovering it from the
   *   end of the array would tie the caller's answer to an ordering nobody has
   *   promised to keep, and a sort added later would hand a caller somebody
   *   else's task.
   */
  test("name the task an add created", () => {
    const created = { ...task, id: "new" };
    const outcome = applyScheduleOp({ op: "add", task: created }, [task]);
    expect(outcome.added).toEqual(created);
    expect(outcome.written).toBe(true);
  });

  /**
   * @case A compaction computed against a stale transcript is refused
   * @preconditions A replacement expecting two turns, against a file that has
   *   since grown to three
   * @expectedResult Refused and nothing written. This is the case a check
   *   inside compact cannot catch: the turn arrived during the model call, so
   *   a check made before it would have passed and erased it.
   */
  test("refuse a replacement computed against a transcript that moved", () => {
    const lines = [
      turn("user", "a"),
      turn("assistant", "b"),
      turn("user", "c"),
    ];
    const outcome = applyTranscriptOp(
      {
        op: "replace",
        session: "demo",
        turns: [turn("user", "summary")],
        expect: 2,
      },
      lines,
    );
    expect(outcome.written).toBe(false);
    expect(outcome.refused).toContain("moved from 2 turns to 3");
    expect(outcome.turns).toHaveLength(3);
  });

  /**
   * @case A replacement that is not shorter is refused
   * @preconditions Two turns replaced by two turns, with a matching expect
   * @expectedResult Refused, because a transcript file has no undo and a
   *   compaction that shortens nothing has only risk to offer
   */
  test("refuse a replacement that is no shorter", () => {
    const lines = [turn("user", "a"), turn("assistant", "b")];
    const outcome = applyTranscriptOp(
      {
        op: "replace",
        session: "demo",
        turns: [turn("user", "x"), turn("assistant", "y")],
        expect: 2,
      },
      lines,
    );
    expect(outcome.written).toBe(false);
    expect(outcome.refused).toContain("no shorter");
  });

  /**
   * @case An empty replacement is refused
   * @preconditions A model that returned no turns
   * @expectedResult Refused, so a transcript is never replaced by nothing
   */
  test("refuse an empty replacement", () => {
    const outcome = applyTranscriptOp(
      { op: "replace", session: "demo", turns: [], expect: 1 },
      [turn("user", "a")],
    );
    expect(outcome.written).toBe(false);
    expect(outcome.refused).toContain("empty");
  });
});

/**
 * The lock, which is the part a pure function cannot show.
 *
 * `STATE_ROOT` is resolved at import, so these tests use the real schedule
 * file rather than a scratch one. Whatever is there is saved and put back, so
 * running the suite on a machine that has used the harness neither reads that
 * developer's schedule into an assertion nor destroys it.
 */
describe("the schedule file has one owner", () => {
  let t: TestContext | undefined;
  let saved: string | undefined;

  beforeEach(async () => {
    saved = await readFile(SCHEDULES_FILE, "utf8").catch(() => undefined);
    await rm(SCHEDULES_FILE, { force: true });
  });

  afterEach(async () => {
    await t?.stop();
    t = undefined;
    if (saved === undefined) await rm(SCHEDULES_FILE, { force: true });
    else await writeFile(SCHEDULES_FILE, saved);
    saved = undefined;
  });

  /**
   * @case Concurrent writers do not lose each other's tasks
   * @preconditions No schedule file, then twenty schedule-task calls
   *   dispatched at once against a context holding the owner
   * @expectedResult All twenty are in the file. Each call is a read, a modify
   *   and a write, so without the owner serialising the whole cycle the ones
   *   that read before their neighbours wrote overwrite them, and the route
   *   reports success for every task it silently dropped.
   */
  test("keep every task twenty callers add at once", async () => {
    t = await testContext()
      .routes([schedulesOwner, scheduleTask, listSchedules])
      .build();
    await t.startAndWaitReady();

    const created = await Promise.all(
      Array.from({ length: 20 }, (_unused, index) =>
        t!.client.sendDirect<unknown, { id: string; task: string }>(
          "schedule-task",
          { task: `task ${index}`, session: "demo", inMinutes: 60 },
        ),
      ),
    );

    // Each caller is answered with its own task, not whichever one happened to
    // land last in the file.
    expect(new Set(created.map((entry) => entry.id)).size).toBe(20);
    for (const [index, entry] of created.entries()) {
      expect(entry.task).toBe(`task ${index}`);
    }

    const listed = await t.client.sendDirect<unknown, { tasks: unknown[] }>(
      "list-schedules",
      {},
    );
    expect(listed.tasks).toHaveLength(20);
  });

  /**
   * @case A cancellation lands against the file as it is, not as it was read
   * @preconditions One task added, then a cancel and another add dispatched
   *   together
   * @expectedResult The cancellation is reported against a file that still
   *   holds the task it names, and the task added alongside it survives
   */
  test("cancel and add without either losing the other", async () => {
    t = await testContext()
      .routes([schedulesOwner, scheduleTask, cancelSchedule, listSchedules])
      .build();
    await t.startAndWaitReady();

    const first = await t.client.sendDirect<unknown, { id: string }>(
      "schedule-task",
      { task: "first", session: "demo", inMinutes: 60 },
    );

    const [cancelled] = await Promise.all([
      t.client.sendDirect<unknown, { cancelled: boolean; remaining: number }>(
        "cancel-schedule",
        { id: first.id },
      ),
      t.client.sendDirect("schedule-task", {
        task: "second",
        session: "demo",
        inMinutes: 60,
      }),
    ]);

    expect(cancelled.cancelled).toBe(true);
    const listed = await t.client.sendDirect<
      unknown,
      { tasks: { task: string }[] }
    >("list-schedules", {});
    expect(listed.tasks.map((task) => task.task)).toEqual(["second"]);
  });
});

/**
 * The same property for transcripts, where the key is the conversation.
 */
describe("a transcript has one owner", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.stop();
    t = undefined;
    await rm(transcriptFile("owner-a"), { force: true });
    await rm(transcriptFile("owner-b"), { force: true });
  });

  /**
   * @case Concurrent appends to one conversation all survive
   * @preconditions Twelve appends dispatched at once against a session with
   *   no transcript file
   * @expectedResult Every turn is on disk. Each append is a read, a modify and
   *   a write, so without the owner holding the file for the whole cycle the
   *   later ones overwrite the earlier, and chat reports a reply it has
   *   already lost the question for.
   */
  test("keep every turn twelve callers append at once", async () => {
    t = await testContext().routes([transcriptOwner]).build();
    await t.startAndWaitReady();

    await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        t!.client.sendDirect("transcript-owner", {
          op: "append",
          session: "owner-a",
          turns: [turn("user", `message ${index}`)],
        }),
      ),
    );

    const read = await t.client.sendDirect<unknown, { turns: unknown[] }>(
      "transcript-owner",
      { op: "read", session: "owner-a" },
    );
    expect(read.turns).toHaveLength(12);
  });

  /**
   * @case Reading a conversation that does not exist creates nothing
   * @preconditions A read for a session with no transcript file
   * @expectedResult No file. A mistyped `--session` is the most likely input
   *   this harness gets, and answering it by creating the file it named would
   *   let any caller litter the state directory by reading.
   */
  test("create no file for a read of a session that has none", async () => {
    t = await testContext().routes([transcriptOwner]).build();
    await t.startAndWaitReady();

    const read = await t.client.sendDirect<unknown, { turns: unknown[] }>(
      "transcript-owner",
      { op: "read", session: "owner-a" },
    );

    expect(read.turns).toEqual([]);
    expect(
      await readFile(transcriptFile("owner-a"), "utf8").catch(() => undefined),
    ).toBeUndefined();
  });

  /**
   * @case Two conversations do not queue behind each other
   * @preconditions Appends to two different sessions
   * @expectedResult Each transcript holds only its own turns, which is what
   *   keying the lock by session rather than by route buys
   */
  test("keep two conversations apart", async () => {
    t = await testContext().routes([transcriptOwner]).build();
    await t.startAndWaitReady();

    await Promise.all([
      t.client.sendDirect("transcript-owner", {
        op: "append",
        session: "owner-a",
        turns: [turn("user", "to a")],
      }),
      t.client.sendDirect("transcript-owner", {
        op: "append",
        session: "owner-b",
        turns: [turn("user", "to b")],
      }),
    ]);

    const a = await t.client.sendDirect<unknown, { turns: { text: string }[] }>(
      "transcript-owner",
      { op: "read", session: "owner-a" },
    );
    const b = await t.client.sendDirect<unknown, { turns: { text: string }[] }>(
      "transcript-owner",
      { op: "read", session: "owner-b" },
    );
    expect(a.turns.map((entry) => entry.text)).toEqual(["to a"]);
    expect(b.turns.map((entry) => entry.text)).toEqual(["to b"]);
  });
});

/**
 * A route that reports work done has done it.
 *
 * `.tap()` is detached by contract: the framework runs it on a tracked task
 * and the pipeline continues immediately. Every write in this harness used
 * one, so each route answered its caller before the file existed. The lock on
 * the owners cannot help with that, because a lock only serialises work the
 * route waits for.
 */
describe("a write is finished before the route answers", () => {
  let t: TestContext | undefined;
  const written = join(WORKSPACE_ROOT, "durability-check.txt");

  afterEach(async () => {
    await t?.stop();
    t = undefined;
    await rm(written, { force: true });
  });

  /**
   * @case The file is on disk the moment the caller is answered
   * @preconditions A workspace write dispatched and awaited
   * @expectedResult The content is readable immediately. The route reports the
   *   byte count it wrote, and a caller acting on that answer, an agent
   *   telling someone the file is saved, is entitled to find it there.
   */
  test("answer only once the content is readable", async () => {
    t = await testContext().routes([workspaceWrite]).build();
    await t.startAndWaitReady();

    await t.client.sendDirect("workspace-write", {
      path: "workspace/durability-check.txt",
      content: "written before the answer",
    });

    expect(await readFile(written, "utf8")).toBe("written before the answer");
  });
});
