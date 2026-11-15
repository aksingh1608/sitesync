import { describe, expect, it } from "vitest";
import { groupTasks } from "@/lib/tasks/grouping";
import { addDays, dayKey, endOfMonthKey, endOfWeekKey, isoWeekday, zonedTime } from "@/lib/time";
import type { TaskRow } from "@/lib/sync/reducers";

const TZ = "America/New_York";
const task = (id: string, dueAt: string | null, extra: Partial<TaskRow> = {}): TaskRow => ({
  id,
  title: id,
  description: "",
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

describe("groupTasks", () => {
  // Wednesday 2026-11-11, 10:00 in New York. Week = Mon 9th .. Sun 15th.
  const now = new Date("2026-11-11T15:00:00Z");

  it("buckets by the branch's local day into calendar weeks starting Monday", () => {
    const g = groupTasks(
      [
        task("overdue", "2026-11-09T15:00:00Z"),
        // 23:30 New York on the 11th is already the 12th in UTC: still today.
        task("late-today", "2026-11-12T04:30:00Z"),
        task("tomorrow", "2026-11-12T15:00:00Z"),
        task("sunday-late", "2026-11-16T04:30:00Z"), // Sun 15th 23:30 NY (Monday in UTC)
        task("next-monday", "2026-11-16T15:00:00Z"),
        task("nov-30-late", "2026-12-01T04:30:00Z"), // Mon 30th 23:30 NY
        task("dec-1", "2026-12-01T15:00:00Z"),
        task("undated", null),
        task("follow", "2026-11-05T15:00:00Z", { kind: "follow_up" }),
        task("closed", "2026-11-05T15:00:00Z", { status: "done" }),
      ],
      now,
      TZ,
    );
    expect(ids(g.overdue)).toEqual(["overdue"]);
    expect(ids(g.today)).toEqual(["late-today"]);
    expect(ids(g.thisWeek)).toEqual(["tomorrow", "sunday-late"]);
    expect(ids(g.thisMonth)).toEqual(["next-monday", "nov-30-late"]);
    expect(ids(g.later)).toEqual(["dec-1", "undated"]);
    expect(ids(g.followUps)).toEqual(["follow"]); // overdue follow-ups stay follow-ups
    expect(ids(g.closed)).toEqual(["closed"]);
  });

  describe("at midnight in New York (Sunday -> Monday)", () => {
    const tasks = [
      task("sun-evening", "2026-11-16T01:00:00Z"), // Sun 15th 20:00 NY
      task("mon-morning", "2026-11-16T14:00:00Z"), // Mon 16th 09:00 NY
      task("sun-next", "2026-11-23T01:00:00Z"), // Sun 22nd 20:00 NY
    ];

    it("one minute before midnight, it is still Sunday: Monday is next week", () => {
      const g = groupTasks(tasks, new Date("2026-11-16T04:59:00Z"), TZ); // Sun 23:59 NY
      expect(ids(g.today)).toEqual(["sun-evening"]);
      expect(g.thisWeek).toEqual([]); // the week ends today
      expect(ids(g.thisMonth)).toEqual(["mon-morning", "sun-next"]);
    });

    it("at midnight, a new week starts", () => {
      const g = groupTasks(tasks, new Date("2026-11-16T05:00:00Z"), TZ); // Mon 00:00 NY
      expect(ids(g.overdue)).toEqual(["sun-evening"]);
      expect(ids(g.today)).toEqual(["mon-morning"]);
      expect(ids(g.thisWeek)).toEqual(["sun-next"]);
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

  it("lets This Week run into next month, and This Month end with the calendar month", () => {
    const g = groupTasks(
      [task("dec-3", "2026-12-03T15:00:00Z"), task("dec-7", "2026-12-07T15:00:00Z")],
      new Date("2026-11-30T15:00:00Z"), // Monday 30th
      TZ,
    );
    expect(ids(g.thisWeek)).toEqual(["dec-3"]);
    expect(g.thisMonth).toEqual([]);
    expect(ids(g.later)).toEqual(["dec-7"]);
  });

  it("computes week and month ends", () => {
    expect(isoWeekday("2026-11-16")).toBe(1);
    expect(isoWeekday("2026-11-15")).toBe(7);
    expect(endOfWeekKey("2026-11-16")).toBe("2026-11-22");
    expect(endOfWeekKey("2026-11-22")).toBe("2026-11-22");
    expect(endOfMonthKey("2026-02-10")).toBe("2026-02-28");
    expect(endOfMonthKey("2028-02-10")).toBe("2028-02-29");
    expect(endOfMonthKey("2026-12-31")).toBe("2026-12-31");
  });

  it("computes local wall-clock times across DST", () => {
    expect(zonedTime("2026-07-01", 9, 0, TZ).toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(zonedTime("2026-12-01", 9, 0, TZ).toISOString()).toBe("2026-12-01T14:00:00.000Z");
    expect(addDays("2026-11-28", 7)).toBe("2026-12-05");
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08"); // DST start day
  });
});
