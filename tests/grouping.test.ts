import { describe, expect, it } from "vitest";
import { groupTasks } from "@/lib/tasks/grouping";
import { addDays, zonedTime } from "@/lib/time";
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

describe("groupTasks", () => {
  // 2026-11-11, 10:00 in New York.
  const now = new Date("2026-11-11T15:00:00Z");

  it("buckets by the branch's local day, with overdue in Today", () => {
    const g = groupTasks(
      [
        task("overdue", "2026-11-09T15:00:00Z"),
        // 23:30 New York on the 11th is already the 12th in UTC: still today.
        task("late-today", "2026-11-12T04:30:00Z"),
        task("in-7-days", "2026-11-18T15:00:00Z"),
        task("in-7-days-late", "2026-11-19T04:30:00Z"), // 23:30 NY on the 18th
        task("in-8-days", "2026-11-19T15:00:00Z"),
        task("in-31-days", "2026-12-12T15:00:00Z"),
        task("in-32-days", "2026-12-13T15:00:00Z"),
        task("undated", null),
        task("follow", "2026-11-11T15:00:00Z", { kind: "follow_up" }),
        task("closed", "2026-11-11T15:00:00Z", { status: "done" }),
      ],
      now,
      TZ,
    );
    expect(g.today.map((t) => t.id)).toEqual(["overdue", "late-today"]);
    expect(g.thisWeek.map((t) => t.id)).toEqual(["in-7-days", "in-7-days-late"]);
    expect(g.thisMonth.map((t) => t.id)).toEqual(["in-8-days", "in-31-days"]);
    expect(g.later.map((t) => t.id)).toEqual(["in-32-days", "undated"]);
    expect(g.followUps.map((t) => t.id)).toEqual(["follow"]);
    expect(g.closed.map((t) => t.id)).toEqual(["closed"]);
  });

  it("computes local wall-clock times across DST", () => {
    expect(zonedTime("2026-07-01", 9, 0, TZ).toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(zonedTime("2026-12-01", 9, 0, TZ).toISOString()).toBe("2026-12-01T14:00:00.000Z");
    expect(addDays("2026-11-28", 7)).toBe("2026-12-05");
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08"); // DST start day
  });
});
