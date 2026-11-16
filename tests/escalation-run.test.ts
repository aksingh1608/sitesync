// Escalation runner on PGlite: the Day 4 demo flow with fast-forward, no
// duplicates under concurrent runs, push cleanup (404/410), SMS routing
// (only the demo person gets real SMS), throttling.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimRunSlot, moveClock } from "@/lib/clock";
import { demoSettings, escalations, people, pushSubscriptions, smsMessages } from "@/lib/db/schema";
import { runEscalations, shortCode, type RunDeps } from "@/lib/escalation/run";
import type { PushSender } from "@/lib/push/send";
import type { SmsEnv, SmsProvider } from "@/lib/sms/provider";
import { maskNumber, routeSms } from "@/lib/sms/provider";
import { mapTwilioStatus } from "@/lib/sms/twilio";
import type { Db } from "@/lib/sync/store-drizzle";
import { processSync } from "@/lib/sync/service";
import { event, ids, makeDb, uuid } from "./helpers";

/** Like helpers.sync, but with the real clock (these tests use real time + demo offsets). */
async function sync(d: Db, actorId: string, events: unknown[]) {
  const out = await processSync(d, { deviceId: "test-device", actorId, cursor: null, events });
  if (!out.ok) throw new Error(out.error);
  return out.response;
}

let db: Db;
let close: () => Promise<void>;
let pushes: { endpoint: string; payload: { title: string; body: string; url: string } }[];
let pushFail: Record<string, number>;
const pushSender: PushSender = async (target, payload) => {
  const code = pushFail[target.endpoint];
  if (code) throw Object.assign(new Error(`push ${code}`), { statusCode: code });
  pushes.push({ endpoint: target.endpoint, payload: JSON.parse(payload) });
};
const twilioSent: { to: string; body: string }[] = [];
const fakeTwilio: SmsProvider = {
  name: "twilio",
  async send(m) {
    twilioSent.push(m);
    return { status: "queued", providerId: "SM123", sentBody: "template text", error: null };
  },
};
const mockEnv: SmsEnv = { provider: "mock", demoTo: null, twilio: null };

beforeEach(async () => {
  ({ db, close } = await makeDb());
  pushes = [];
  pushFail = {};
  twilioSent.length = 0;
  await db.update(people).set({ phone: "+12125550199" }).where(eq(people.id, ids.techA));
});
afterEach(async () => close());

const REAL = new Date();
const deps = (over: Partial<RunDeps> = {}): RunDeps => ({ push: pushSender, sms: { env: mockEnv }, real: REAL, ...over });
const run = (d: RunDeps = deps()) => runEscalations(db, { trigger: "test", deps: d });
const rows = () => db.select().from(escalations).orderBy(escalations.createdAt, escalations.level);
const subscribe = (personId: string, endpoint: string) =>
  db.insert(pushSubscriptions).values({ id: uuid(), personId, endpoint, p256dh: "k", auth: "a" });

async function urgentTask(clientTs = REAL.toISOString()) {
  const taskId = uuid();
  const r = await sync(db, ids.coordinator, [
    event({
      type: "task.created",
      actorId: ids.coordinator,
      clientTs,
      payload: { taskId, title: "Store 114 parking lot lights out", siteId: ids.siteA, assigneeId: ids.techA, priority: "urgent" },
    } as never),
  ]);
  expect(r.rejected).toEqual([]);
  return taskId;
}

describe("demo run: urgent task for an offline technician", () => {
  it("push, +30 push again, +60 SMS (mock), +90 coordinator alert; acknowledging stops everything", async () => {
    await subscribe(ids.techA, "https://push.example/tech");
    await subscribe(ids.coordinator, "https://push.example/coord");
    const taskId = await urgentTask();

    await run();
    expect(pushes.map((p) => p.payload.title)).toEqual(["Urgent: Store 114 parking lot lights out"]);
    expect(pushes[0].payload.url).toBe(`/field/task?id=${taskId}`);

    await moveClock(db, "+30m", ids.manager, REAL);
    await run();
    expect(pushes.map((p) => p.payload.title).at(-1)).toBe("Reminder: Store 114 parking lot lights out");

    await moveClock(db, "+30m", ids.manager, REAL);
    await run();
    const sms = await db.select().from(smsMessages);
    expect(sms).toHaveLength(1);
    expect(sms[0]).toMatchObject({ provider: "mock", status: "mocked", personId: ids.techA, toMasked: "+1 ••• ••• ••99" });
    expect(sms[0].body).toContain(`/t/${shortCode(taskId)}`);
    expect(sms[0].body).toContain("Store 114 parking lot lights out at Site A");

    await moveClock(db, "+30m", ids.manager, REAL);
    await run();
    const alert = (await rows()).find((r) => r.channel === "coordinator_alert")!;
    expect(alert).toMatchObject({ level: 3, status: "sent", resolvedAt: null, personId: ids.coordinator });
    expect(pushes.at(-1)).toMatchObject({ endpoint: "https://push.example/coord", payload: { url: `/office/tasks?task=${taskId}` } });

    // Acknowledge: the alert resolves itself; further fast-forwards do nothing.
    await sync(db, ids.techA, [event({ type: "task.acknowledged", actorId: ids.techA, clientTs: new Date().toISOString(), payload: { taskId } } as never)]);
    const after = await run();
    expect(after.resolved).toBe(1);
    const count = (await rows()).length;
    await moveClock(db, "+1h", ids.manager, REAL);
    await moveClock(db, "+1h", ids.manager, REAL);
    await run();
    expect((await rows()).length).toBe(count);
    expect((await rows()).map((r) => `${r.level}:${r.channel}:${r.status}`)).toEqual([
      "0:push:sent",
      "1:push:sent",
      "2:sms:sent",
      "3:coordinator_alert:resolved",
    ]);
  });

  it("no subscription: the push step is recorded as skipped, the ladder still moves on", async () => {
    await urgentTask();
    await run();
    const [first] = await rows();
    expect(first).toMatchObject({ status: "skipped", error: "no push subscription" });
  });
});

describe("no duplicates", () => {
  it("concurrent runs send each step exactly once", async () => {
    await subscribe(ids.techA, "https://push.example/tech");
    await urgentTask();
    const results = await Promise.all([run(), run(), run(), run()]);
    expect(pushes).toHaveLength(1);
    expect((await rows()).length).toBe(1);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(1);
    expect(results.reduce((n, r) => n + r.lost, 0)).toBe(3);
  });

  it("the unique key rejects a second row for the same step", async () => {
    const taskId = await urgentTask();
    const row = { taskId, personId: ids.techA, rule: "ack" as const, episode: "x", level: 1, channel: "push" as const, reason: "r", scheduledFor: REAL };
    await db.insert(escalations).values({ id: uuid(), ...row });
    await expect(db.insert(escalations).values({ id: uuid(), ...row })).rejects.toThrow();
  });
});

describe("push delivery", () => {
  it("deletes subscriptions the push service reports gone (404/410), keeps others", async () => {
    await subscribe(ids.techA, "https://push.example/gone");
    await subscribe(ids.techA, "https://push.example/missing");
    await subscribe(ids.techA, "https://push.example/flaky");
    await subscribe(ids.techA, "https://push.example/ok");
    pushFail = { "https://push.example/gone": 410, "https://push.example/missing": 404, "https://push.example/flaky": 500 };
    await urgentTask();
    await run();
    const left = await db.select().from(pushSubscriptions);
    expect(left.map((s) => s.endpoint).sort()).toEqual(["https://push.example/flaky", "https://push.example/ok"]);
    expect(left.find((s) => s.endpoint.endsWith("flaky"))!.failureCount).toBe(1);
    const [first] = await rows();
    expect(first).toMatchObject({ status: "sent", providerId: "1/4 devices" });
  });
});

describe("SMS routing", () => {
  const twilioEnv: SmsEnv = { provider: "twilio", demoTo: "+4915112345678", twilio: { accountSid: "AC1", authToken: "t", from: "+4930123" } };

  it("only the demo person is texted for real; everyone else goes to mock", () => {
    expect(routeSms(twilioEnv, "p1", "p1", "+1555")).toEqual({ via: "twilio", to: "+4915112345678" });
    expect(routeSms(twilioEnv, "p2", "p1", "+1555")).toEqual({ via: "mock", to: "+1555" });
    expect(routeSms(twilioEnv, "p1", null, "+1555")).toEqual({ via: "mock", to: "+1555" });
    expect(routeSms(mockEnv, "p1", "p1", "+1555")).toEqual({ via: "mock", to: "+1555" });
    expect(routeSms({ ...twilioEnv, twilio: null }, "p1", "p1", null)).toMatchObject({ via: "misconfigured" });
  });

  it("the demo person's escalation SMS goes through Twilio; the number is stored masked", async () => {
    await db.update(demoSettings).set({ smsDemoPersonId: ids.techA });
    await urgentTask();
    const d = deps({ sms: { env: twilioEnv, twilio: fakeTwilio } });
    await run(d);
    await moveClock(db, "+1h", ids.manager, REAL);
    await run(d);
    expect(twilioSent).toHaveLength(1);
    expect(twilioSent[0].to).toBe("+4915112345678");
    const [sms] = await db.select().from(smsMessages);
    expect(sms).toMatchObject({ provider: "twilio", status: "queued", providerId: "SM123", toMasked: "+49 ••• ••• ••78", sentBody: "template text" });
    expect(JSON.stringify(sms)).not.toContain("15112345678");
  });

  it("maps Twilio statuses and masks numbers", () => {
    expect(["queued", "accepted", "sent", "delivered", "undelivered", "failed"].map(mapTwilioStatus)).toEqual([
      "queued",
      "queued",
      "sent",
      "delivered",
      "undelivered",
      "failed",
    ]);
    expect(maskNumber("+4915112345678")).toBe("+49 ••• ••• ••78");
  });
});

describe("throttle and clock", () => {
  it("dashboard polls run at most once per 30 s across instances", async () => {
    expect(await claimRunSlot(db, 30, REAL)).toBe(true);
    expect(await claimRunSlot(db, 30, new Date(REAL.getTime() + 10_000))).toBe(false);
    expect(await claimRunSlot(db, 30, new Date(REAL.getTime() + 31_000))).toBe(true);
    const throttled = await runEscalations(db, { trigger: "poll", throttle: true, deps: deps({ real: new Date(REAL.getTime() + 40_000) }) });
    expect(throttled.ran).toBe(false);
  });

  it("fast-forward adds up and resets", async () => {
    await moveClock(db, "+15m", ids.manager, REAL);
    const c = await moveClock(db, "+1h", ids.manager, REAL);
    expect(c.offsetMs).toBe(75 * 60_000);
    expect(c.now.getTime() - REAL.getTime()).toBe(75 * 60_000);
    expect((await moveClock(db, "reset", ids.manager, REAL)).offsetMs).toBe(0);
  });
});
