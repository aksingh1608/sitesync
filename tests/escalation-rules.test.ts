// Pure escalation rules with a fixed clock: every threshold, stop conditions,
// catch-up, staleness and the demo-clock offset.
import { describe, expect, it } from "vitest";
import { clockAt } from "@/lib/clock";
import type { TaskPriority, TaskStatus } from "@/lib/domain";
import {
  ackEpisode,
  dueLabel,
  evaluateEscalations,
  type EscalationState,
  type EvalStep,
  type EvalTask,
  type StepAction,
} from "@/lib/escalation/rules";

const T0 = new Date("2026-11-16T14:00:00Z"); // 9:00 AM New York
const min = (m: number) => new Date(T0.getTime() + m * 60_000);
const P = { tech: "p-tech", coord: "p-coord", coord2: "p-coord2", mgr: "p-mgr", hr: "p-hr" };
const people = [
  { id: P.tech, name: "Tess Tech", role: "technician" as const, active: true },
  { id: P.coord, name: "Cora Coordinator", role: "coordinator" as const, active: true },
  { id: P.coord2, name: "Cal Coordinator", role: "coordinator" as const, active: true },
  { id: P.mgr, name: "Max Manager", role: "manager" as const, active: true },
  { id: P.hr, name: "Hana HR", role: "hr" as const, active: true },
];
const stamp = (at: Date, ev: string) => ({ ts: at.toISOString(), ev });

function task(over: Partial<EvalTask> = {}): EvalTask {
  const createdAt = over.createdAt ?? T0;
  const s = stamp(createdAt, "ev-create");
  return {
    id: "task-1",
    title: "Store 114 parking lot lights out",
    siteId: "site-1",
    assigneeId: P.tech,
    createdBy: P.coord,
    kind: "task",
    priority: "urgent",
    status: "open",
    dueAt: null,
    createdAt,
    fieldTs: { title: s, dueAt: s, priority: s, status: s },
    ...over,
  };
}

/** A tiny in-memory "database": apply returned steps like run.ts would. */
function world(t: EvalTask, opts: { ack?: Date | null; sentAt?: Date } = {}) {
  const state: EscalationState = {
    tasks: [t],
    receipts: [{ taskId: t.id, personId: t.assigneeId, sentAt: opts.sentAt ?? t.createdAt, acknowledgedAt: opts.ack ?? null }],
    people,
    sites: [{ id: "site-1", name: "Store 114" }],
    steps: [],
  };
  let n = 0;
  const run = (now: Date, offsetMs = 0) => {
    const clock = { now, offsetMs };
    const actions = evaluateEscalations(state, clock);
    for (const a of actions) {
      if (a.kind === "step") {
        state.steps.push({
          id: `esc-${++n}`,
          taskId: a.taskId,
          rule: a.rule,
          episode: a.episode,
          level: a.level,
          channel: a.channel,
          status: a.skip ? "skipped" : "sent",
          scheduledFor: a.dueAt,
          resolvedAt: null,
          handled: false,
        } satisfies EvalStep);
      } else {
        const s = state.steps.find((x) => x.id === a.escalationId)!;
        if (a.channel === "coordinator_alert") s.status = "resolved";
        s.resolvedAt = now;
      }
    }
    return actions;
  };
  return { state, run };
}
const steps = (actions: ReturnType<typeof evaluateEscalations>) =>
  actions.filter((a): a is StepAction => a.kind === "step").map((a) => `${a.rule}:${a.level}:${a.channel}${a.skip ? `(${a.skip})` : ""}`);

describe("ack ladder (sent, not acknowledged)", () => {
  it.each<[TaskPriority, number]>([
    ["urgent", 1],
    ["high", 1],
    ["normal", 2],
  ])("%s: level 0 at once, then +30/+60/+90 min x%i", (priority, f) => {
    const { run } = world(task({ priority }));
    expect(steps(run(min(0)))).toEqual(["ack:0:push"]);
    expect(steps(run(min(30 * f - 1)))).toEqual([]);
    expect(steps(run(min(30 * f)))).toEqual(["ack:1:push"]);
    expect(steps(run(min(60 * f - 1)))).toEqual([]);
    expect(steps(run(min(60 * f)))).toEqual(["ack:2:sms"]);
    expect(steps(run(min(90 * f - 1)))).toEqual([]);
    expect(steps(run(min(90 * f)))).toEqual(["ack:3:coordinator_alert"]);
    expect(steps(run(min(600)))).toEqual([]); // nothing after the last level
  });

  it("low priority: the first push only, never escalated", () => {
    const { run } = world(task({ priority: "low" }));
    expect(steps(run(min(0)))).toEqual(["ack:0:push"]);
    expect(steps(run(min(1000)))).toEqual([]);
  });

  it("the ladder counts from when the engine first saw the task, on the demo clock", () => {
    const { run } = world(task());
    run(min(0), 0);
    // Fast-forward 30 min: real time is still T0.
    expect(steps(run(min(30), 30 * 60_000))).toEqual(["ack:1:push"]);
  });

  it("catch-up: when several levels are due at once only the highest is sent", () => {
    const { run } = world(task());
    run(min(0));
    expect(steps(run(min(95)))).toEqual(["ack:1:push(superseded)", "ack:2:sms(superseded)", "ack:3:coordinator_alert"]);
  });

  it("stale first push: a task sent long ago (real time) is recorded but not pushed; fast-forward never makes it stale", () => {
    const old = world(task({ createdAt: min(-120) }));
    expect(steps(old.run(min(0)))).toEqual(["ack:0:push(stale)"]);
    const ff = world(task());
    // Demo clock already 3 h ahead when the task is created: still fresh.
    expect(steps(ff.run(min(180), 180 * 60_000))).toEqual(["ack:0:push"]);
  });

  it("stops when acknowledged and resolves the open alert", () => {
    const w = world(task());
    w.run(min(0));
    w.run(min(90));
    w.state.receipts[0].acknowledgedAt = min(91);
    const out = w.run(min(92));
    // Every open step of the ladder closes (levels 1-2 were superseded, never open).
    expect(out.map((a) => a.kind === "resolve" && `${a.channel}:${a.why}`)).toEqual(["push:acknowledged", "coordinator_alert:acknowledged"]);
    expect(steps(w.run(min(1000)))).toEqual([]);
  });

  it.each<[TaskStatus, string]>([
    ["done", "task done"],
    ["cancelled", "task cancelled"],
  ])("stops when %s", (status, why) => {
    const w = world(task());
    w.run(min(0));
    w.run(min(90));
    w.state.tasks[0].status = status;
    const out = w.run(min(91));
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((a) => a.kind === "resolve" && a.why === why)).toBe(true);
    expect(w.run(min(2000))).toEqual([]);
  });

  it("Mark handled stops the ladder; a new episode starts fresh", () => {
    const w = world(task());
    w.run(min(0));
    w.run(min(30));
    w.state.steps.forEach((s) => (s.handled = true));
    expect(steps(w.run(min(500)))).toEqual([]);
  });

  it("an already acknowledged task never escalates", () => {
    const { run } = world(task(), { ack: min(1) });
    expect(run(min(0))).toEqual([]);
    expect(run(min(500))).toEqual([]);
  });

  it("reassignment starts a new ladder for the new assignee", () => {
    const w = world(task());
    w.run(min(0));
    w.run(min(30));
    w.state.tasks[0].assigneeId = "p-tech2";
    w.state.people.push({ id: "p-tech2", name: "Theo", role: "technician", active: true });
    w.state.receipts.push({ taskId: "task-1", personId: "p-tech2", sentAt: min(40), acknowledgedAt: null });
    const out = w.run(min(41));
    expect(steps(out)).toEqual(["ack:0:push"]);
    expect((out[0] as StepAction).episode).toBe(ackEpisode("p-tech2", min(40)));
    expect(steps(w.run(min(71)))).toEqual(["ack:1:push"]);
  });

  it("office assignees (material requests) get the first push only", () => {
    const { run } = world(task({ kind: "material_request", assigneeId: P.coord, createdBy: P.tech, priority: "high" }));
    const out = run(min(0));
    expect(steps(out)).toEqual(["ack:0:push"]);
    expect((out[0] as StepAction).message.title).toBe("Material request: Store 114 parking lot lights out");
    expect(steps(run(min(500)))).toEqual([]);
  });

  it("alerts go to the creator (office) and every coordinator, not HR", () => {
    const { run } = world(task({ createdBy: P.mgr }));
    run(min(0));
    const alert = (run(min(90)) as StepAction[]).find((a) => !a.skip)!;
    expect(alert.channel).toBe("coordinator_alert");
    expect(alert.personId).toBe(P.mgr);
    expect(alert.pushTo).toEqual([P.mgr, P.coord, P.coord2]);
  });

  it("notification text is short and specific", () => {
    const { run } = world(task({ dueAt: new Date("2026-11-16T19:00:00Z") }));
    const [a] = run(min(0)) as StepAction[];
    expect(a.message).toEqual({ title: "Urgent: Store 114 parking lot lights out", body: "New task at Store 114. Due 2:00 PM." });
    expect(dueLabel(new Date("2026-11-18T19:00:00Z"), T0)).toBe("Wed, Nov 18, 2:00 PM");
  });
});

describe("overdue", () => {
  const due = min(-10);
  it("reminds the assignee once, then alerts the coordinator 2 h after the reminder", () => {
    const { run } = world(task({ dueAt: due }), { ack: min(-60) });
    expect(steps(run(min(0)))).toEqual(["overdue:1:push"]);
    expect(steps(run(min(119)))).toEqual([]);
    expect(steps(run(min(120)))).toEqual(["overdue:2:coordinator_alert"]);
    expect(steps(run(min(999)))).toEqual([]);
  });

  it("not before the due time, not for follow-ups, low priority or closed tasks", () => {
    expect(steps(world(task({ dueAt: min(5) }), { ack: min(-1) }).run(min(0)))).toEqual([]);
    expect(steps(world(task({ dueAt: due, kind: "follow_up" }), { ack: min(-1) }).run(min(0)))).toEqual([]);
    expect(steps(world(task({ dueAt: due, priority: "low" }), { ack: min(-1) }).run(min(0)))).toEqual([]);
    expect(steps(world(task({ dueAt: due, status: "done" }), { ack: min(-1) }).run(min(0)))).toEqual([]);
  });

  it("a new due date is a new episode; the old alert resolves", () => {
    const w = world(task({ dueAt: due }), { ack: min(-60) });
    w.run(min(0));
    w.run(min(120));
    w.state.tasks[0].dueAt = min(300);
    w.state.tasks[0].fieldTs.dueAt = stamp(min(121), "ev-due");
    const out = w.run(min(122));
    expect(out).toContainEqual(expect.objectContaining({ kind: "resolve", why: "due date moved" }));
  });
});

describe("blocked", () => {
  it("pushes coordinators at once and alerts after 2 h; unblocking resolves", () => {
    const w = world(task({ status: "blocked", fieldTs: { status: stamp(min(0), "ev-block") } }), { ack: min(-5) });
    const first = w.run(min(0)) as StepAction[];
    expect(steps(first)).toEqual(["blocked:0:push"]);
    expect(first[0].pushTo).toEqual([P.coord, P.coord2]);
    expect(steps(w.run(min(119)))).toEqual([]);
    expect(steps(w.run(min(120)))).toEqual(["blocked:1:coordinator_alert"]);
    w.state.tasks[0].status = "in_progress";
    expect(w.run(min(121))).toEqual([
      expect.objectContaining({ kind: "resolve", channel: "push", why: "no longer blocked" }),
      expect.objectContaining({ kind: "resolve", channel: "coordinator_alert", why: "no longer blocked" }),
    ]);
  });

  it("blocked again later is a new episode", () => {
    const w = world(task({ status: "blocked", fieldTs: { status: stamp(min(0), "ev-b1") } }), { ack: min(-5) });
    w.run(min(0));
    w.state.tasks[0].fieldTs = { status: stamp(min(200), "ev-b2") };
    expect(steps(w.run(min(200)))).toEqual(["blocked:0:push"]);
  });
});

describe("changed (due date / priority)", () => {
  it("notifies the assignee of a fresh change, not of the creation", () => {
    const w = world(task(), { ack: min(1) });
    expect(w.run(min(5))).toEqual([]);
    w.state.tasks[0].fieldTs = { ...w.state.tasks[0].fieldTs, priority: stamp(min(10), "ev-prio") };
    w.state.tasks[0].priority = "high";
    const out = w.run(min(11)) as StepAction[];
    expect(steps(out)).toEqual(["changed:0:push"]);
    expect(out[0].message.title).toBe("Changed: Store 114 parking lot lights out");
    expect(w.run(min(12))).toEqual([]);
  });

  it("an old change is not announced", () => {
    const w = world(task(), { ack: min(1) });
    w.state.tasks[0].fieldTs = { ...w.state.tasks[0].fieldTs, dueAt: stamp(min(10), "ev-due") };
    expect(w.run(min(200))).toEqual([]);
  });
});

describe("clock", () => {
  it("clockAt adds the demo offset", () => {
    expect(clockAt(T0, 90 * 60_000).now.toISOString()).toBe(min(90).toISOString());
  });
});
