import { describe, expect, it } from "vitest";
import { groupTasks } from "@/lib/tasks/grouping";
import { addDays, dayKey, zonedTime } from "@/lib/time";
import type { TaskRow } from "@/lib/sync/reducers";

const TZ = "America/New_York";
const task = (id: string, dueAt: string | null, extra: Partial<TaskRow> = {}): TaskRow => ({
  id,
  title: id,
  description: "",
  materialStatus: null,
  materialStatusAt: null,
  siteId: "s",
  assigneeId: "p",
  createdBy: "p",
  kind: "task",
  priority: "normal",
  status: "open",
  dueAt: dueAt ? new Date(dueAt) : null,
  parentTaskId: null,
  source: "manual",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  fieldTs: {},
  ...extra,
});

const ids = (rows: TaskRow[]) => rows.map((t) => t.id);

describe("groupTasks (rolling windows, branch time)", () => {
  // Wednesday 2026-11-11, 10:00 in New York.
  const now = new Date("2026-11-11T15:00:00Z");

  it("buckets into Overdue / Today / Next 7 days / Later by the branch's local day", () => {
    const g = groupTasks(
      [
        task("overdue", "2026-11-09T15:00:00Z"),
        // 23:30 New York on the 11th is already the 12th in UTC: still today.
        task("late-today", "2026-11-12T04:30:00Z"),
        task("tomorrow", "2026-11-12T15:00:00Z"),
        task("in-7-days-late", "2026-11-19T04:30:00Z"), // 23:30 NY on the 18th = today + 7
        task("in-8-days", "2026-11-19T15:00:00Z"),
        task("undated", null),
        task("follow", "2026-11-05T15:00:00Z", { kind: "follow_up" }),
        task("closed", "2026-11-05T15:00:00Z", { status: "done" }),
      ],
      now,
      TZ,
    );
    expect(ids(g.overdue)).toEqual(["overdue"]);
    expect(ids(g.today)).toEqual(["late-today"]);
    expect(ids(g.next7)).toEqual(["tomorrow", "in-7-days-late"]);
    expect(ids(g.later)).toEqual(["in-8-days", "undated"]);
    expect(ids(g.followUps)).toEqual(["follow"]); // overdue follow-ups stay follow-ups
    expect(ids(g.closed)).toEqual(["closed"]);
  });

  it("on a Sunday evening, tomorrow's task is in Next 7 days (the phone-test bug)", () => {
    const sundayEvening = new Date("2026-11-16T01:00:00Z"); // Sun 15th, 20:00 NY
    const g = groupTasks([task("monday", "2026-11-16T14:00:00Z")], sundayEvening, TZ);
    expect(ids(g.next7)).toEqual(["monday"]);
    expect(g.later).toEqual([]);
  });

  describe("at midnight in New York", () => {
    const tasks = [
      task("sun-evening", "2026-11-16T01:00:00Z"), // Sun 15th 20:00 NY
      task("mon-morning", "2026-11-16T14:00:00Z"), // Mon 16th 09:00 NY
      task("in-a-week", "2026-11-23T14:00:00Z"), // Mon 23rd 09:00 NY
    ];

    it("one minute before midnight", () => {
      const g = groupTasks(tasks, new Date("2026-11-16T04:59:00Z"), TZ); // Sun 23:59 NY
      expect(ids(g.today)).toEqual(["sun-evening"]);
      expect(ids(g.next7)).toEqual(["mon-morning"]);
      expect(ids(g.later)).toEqual(["in-a-week"]); // the 23rd is today + 8
    });

    it("at midnight the window moves by a day", () => {
      const g = groupTasks(tasks, new Date("2026-11-16T05:00:00Z"), TZ); // Mon 00:00 NY
      expect(ids(g.overdue)).toEqual(["sun-evening"]);
      expect(ids(g.today)).toEqual(["mon-morning"]);
      expect(ids(g.next7)).toEqual(["in-a-week"]); // now today + 7
    });

    it("ignores the device timezone (a tester in Berlin sees New York buckets)", () => {
      const before = process.env.TZ;
      process.env.TZ = "Europe/Berlin"; // 05:59 Monday in Berlin
      try {
        const g = groupTasks(tasks, new Date("2026-11-16T04:59:00Z"), TZ);
        expect(ids(g.today)).toEqual(["sun-evening"]);
        expect(dayKey(new Date("2026-11-16T04:59:00Z"), TZ)).toBe("2026-11-15");
      } finally {
        process.env.TZ = before;
      }
    });
  });

  it("runs across month ends", () => {
    const g = groupTasks(
      [task("dec-3", "2026-12-03T15:00:00Z"), task("dec-8", "2026-12-08T15:00:00Z")],
      new Date("2026-11-30T15:00:00Z"),
      TZ,
    );
    expect(ids(g.next7)).toEqual(["dec-3"]);
    expect(ids(g.later)).toEqual(["dec-8"]);
  });

  it("computes local wall-clock times across DST", () => {
    expect(zonedTime("2026-07-01", 9, 0, TZ).toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(zonedTime("2026-12-01", 9, 0, TZ).toISOString()).toBe("2026-12-01T14:00:00.000Z");
    expect(addDays("2026-11-28", 7)).toBe("2026-12-05");
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08"); // DST start day
  });
});
