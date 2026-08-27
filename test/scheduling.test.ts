import { describe, expect, test } from "bun:test";
import { ScheduleTaskInput } from "../capabilities/scheduling/schedule-task/route.js";
import { isDue, parseTasks } from "../shared/schedule.js";

const task = {
  id: "one",
  dueAt: "2026-08-27T12:00:00.000Z",
  task: "say hello",
  session: "demo",
  createdAt: "2026-08-27T11:00:00.000Z",
};

describe("scheduling", () => {
  /**
   * @case Exactly one of the two ways to say when is required
   * @preconditions Inputs with neither, both, and one
   * @expectedResult Only the one-of forms are accepted, so a request cannot
   *   silently pick a default moment
   */
  test("require exactly one of inMinutes and dueAt", () => {
    const base = { task: "x", session: "demo" };
    expect(ScheduleTaskInput.safeParse(base).success).toBe(false);
    expect(
      ScheduleTaskInput.safeParse({ ...base, inMinutes: 5, dueAt: task.dueAt })
        .success,
    ).toBe(false);
    expect(ScheduleTaskInput.safeParse({ ...base, inMinutes: 5 }).success).toBe(
      true,
    );
    expect(
      ScheduleTaskInput.safeParse({ ...base, dueAt: task.dueAt }).success,
    ).toBe(true);
  });

  /**
   * @case A malformed line does not take the scheduler down
   * @preconditions A file holding one good task and two unusable lines
   * @expectedResult Only the good task survives, so one bad line cannot stop
   *   every other task in the file from ever firing
   */
  test("keep only the lines that parse", () => {
    expect(parseTasks([task, null, { id: "two" }])).toEqual([task]);
  });

  /**
   * @case Due is decided against the moment the tick runs
   * @preconditions A task due at a fixed time, checked before and after it
   * @expectedResult Not due before, due at and after
   */
  test("fire a task at or after its due moment", () => {
    expect(isDue(task, new Date("2026-08-27T11:59:59.999Z"))).toBe(false);
    expect(isDue(task, new Date("2026-08-27T12:00:00.000Z"))).toBe(true);
    expect(isDue(task, new Date("2026-08-28T00:00:00.000Z"))).toBe(true);
  });
});
