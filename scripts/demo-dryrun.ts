// Server-side dry run of docs/demo-script.md against a running server:
//   BASE=http://localhost:3100 pnpm demo:dryrun [--runs 2] [--hourly]
// Reset demo -> inject + approve a request for Sam -> receipt chain while his
// phone is "offline" (no sync) and after -> a dictated text note -> report
// agent tasks -> fast-forward (push, SMS, coordinator alert) -> digest, rollout
// board, timesheet flags. The phone and dashboard UI are not driven here
// (that is the real-device checklist); everything they show comes from these APIs.
// --hourly uses the panel's "+30 min" then "+1 hour" instead of three "+30 min".
// Makes real model calls (~$0.10 a run). WIPES the target database (Reset demo).
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { accessToken } from "@/lib/access";
import { uuidv4 } from "@/lib/uuid";

const BASE = process.env.BASE ?? "http://localhost:3100";
const runs = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 1;
const hourly = process.argv.includes("--hourly");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const access = `sitesync_access=${await accessToken(process.env.DEMO_ACCESS_CODE ?? "")}`;
  let failures = 0;
  for (let run = 1; run <= runs; run++) {
    console.log(`\n=== Run ${run} ===`);
    const check = (ok: boolean, what: string, detail = "") => {
      if (!ok) failures++;
      console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? ` · ${detail}` : ""}`);
    };
    const people = ((await (await fetch(`${BASE}/api/people`, { headers: { cookie: access } })).json()) as { people: { id: string; name: string; role: string }[] }).people;
    const id = (name: string) => people.find((p) => p.name === name)!.id;
    const [marcus, dana, sam] = [id("Marcus Bell"), id("Dana Whitfield"), id("Sam Novak")];
    const office = (who: string) => ({ cookie: `${access}; sitesync_office_actor=${who}`, "content-type": "application/json" });
    const post = async <T>(path: string, body: unknown, who = dana) => {
      const t = Date.now();
      const r = await fetch(`${BASE}${path}`, { method: "POST", headers: office(who), body: JSON.stringify(body) });
      return { status: r.status, body: (await r.json().catch(() => ({}))) as T, ms: Date.now() - t };
    };
    const get = async <T>(path: string, who = dana) => (await (await fetch(`${BASE}${path}`, { headers: office(who) })).json()) as T;
    const device = `dryrun-phone-${run}`;
    const phone = async (events: unknown[]) => {
      const r = await fetch(`${BASE}/api/sync`, {
        method: "POST",
        headers: { cookie: `${access}; sitesync_actor=${sam}`, "content-type": "application/json" },
        body: JSON.stringify({ deviceId: device, actorId: sam, cursor: null, events }),
      });
      return (await r.json()) as { accepted: string[]; changes: { tasks: { id: string; title: string }[]; field_notes: { id: string; report: { createdTasks: { id: string; title: string; priority: string; kind: string }[] } | null }[] } };
    };
    const ev = (type: string, payload: object) => ({ id: uuidv4(), type, actorId: sam, deviceId: device, clientTs: new Date().toISOString(), payload });
    type Snap = { tasks: { id: string; title: string; assigneeId: string }[]; receipts: { taskId: string; personId: string; deliveredAt: string | null; seenAt: string | null; acknowledgedAt: string | null }[]; escalations: { rule: string; level: number; channel: string; status: string; reason: string }[]; sites: { id: string; name: string }[] };
    const stage = async (taskId: string) => {
      const s = await get<Snap>("/api/office/snapshot");
      const r = s.receipts.find((x) => x.taskId === taskId && x.personId === sam);
      return !r ? "none" : r.acknowledgedAt ? "acknowledged" : r.seenAt ? "seen" : r.deliveredAt ? "delivered" : "sent";
    };

    // 0. Reset demo (manager).
    const reset = await post<{ seconds: number }>("/api/office/demo/reset", {}, marcus);
    check(reset.status === 200, "reset demo", `${reset.body.seconds} s`);
    await get("/api/office/snapshot"); // a dashboard poll starts the escalation engine (level 0)
    await sleep(1500);

    // 1-2. Dispatch: inject the cooler-breaker sample, approve for Sam.
    const { samples } = await get<{ samples: string[] }>("/api/office/dispatch");
    const sample = samples.find((s) => /walk-in cooler/.test(s))!;
    const d = await post<{ draftId: string; mode: string; draft: { title: string; suggestedAssigneeId: string | null; priority: string; siteId: string | null } }>("/api/office/dispatch", { text: sample });
    const suggested = people.find((p) => p.id === d.body.draft.suggestedAssigneeId)?.name;
    check(d.status === 200 && !!d.body.draft.siteId, "dispatch draft", `${d.body.mode} in ${(d.ms / 1000).toFixed(1)} s: "${d.body.draft.title}" (${d.body.draft.priority}), suggested ${suggested}`);
    const a = await post<{ taskId: string }>("/api/office/dispatch/decide", { draftId: d.body.draftId, decision: "approve", edits: { assigneeId: sam }, deviceId: "web-dryrun" });
    const taskId = a.body.taskId;
    check(a.status === 200, "approved for Sam Novak");

    // 3. Phone offline: nothing synced yet -> Sent. Then signal returns.
    check((await stage(taskId)) === "sent", "dashboard shows Sent while the phone is offline");
    const pulled = await phone([]);
    check(pulled.changes.tasks.some((t) => t.id === taskId), "phone pulls the task when signal returns");
    await phone([ev("task.delivered", { taskId })]);
    check((await stage(taskId)) === "delivered", "Delivered");
    await phone([ev("task.seen", { taskId })]);
    check((await stage(taskId)) === "seen", "Seen");
    await phone([ev("task.acknowledged", { taskId })]);
    check((await stage(taskId)) === "acknowledged", "Acknowledged (Got it)");

    // 4. Field report: a dictated text note written offline, synced later.
    const s = await get<Snap>("/api/office/snapshot");
    const hospital = s.sites.find((x) => /Northfield/.test(x.name))!.id;
    const noteId = uuidv4();
    const note = ev("note.created", {
      noteId,
      siteId: hospital,
      kind: "text",
      text: "Finished the north lot fixtures, we need 40 more LED panels, and there's an exposed wire near the loading dock",
    });
    const t0 = Date.now();
    await phone([note]);
    let created: { title: string; priority: string; kind: string }[] = [];
    for (let i = 0; i < 40 && !created.length; i++) {
      await sleep(1000);
      created = (await phone([])).changes.field_notes.find((n) => n.id === noteId)?.report?.createdTasks ?? [];
    }
    check(
      created.some((c) => c.kind === "material_request") && created.some((c) => c.priority === "urgent"),
      "report agent: material request + urgent safety task",
      `${((Date.now() - t0) / 1000).toFixed(0)} s after sync: ${created.map((c) => c.title).join(" | ")}`,
    );

    // 5. Escalation by rules: fast-forward.
    const steps = hourly ? (["+30m", "+1h"] as const) : (["+30m", "+30m", "+30m"] as const);
    for (const step of steps) {
      const c = await post<{ run: { sent: number; skipped: number } }>("/api/office/demo-clock", { action: step });
      console.log(`      ${step}: rules sent ${c.body.run?.sent}, skipped ${c.body.run?.skipped}`);
    }
    const esc = (await get<Snap>("/api/office/snapshot")).escalations;
    const sms = await get<{ rows: { status: string; body: string }[] }>("/api/office/sms");
    check(esc.some((e) => e.channel === "coordinator_alert"), "coordinator alert on the board", esc.map((e) => `${e.rule} L${e.level} ${e.channel} ${e.status}`).slice(0, 6).join(", "));
    check(sms.rows.length > 0, "SMS step in the SMS log", sms.rows.slice(0, 2).map((r) => `${r.status}: ${r.body.slice(0, 60)}`).join(" | ") || "none");

    // 6. Rollout board, timesheet flags, digest.
    const ro = await post<{ answer: string; mode: string }>("/api/office/copilot", { question: "Which rollout stores are behind?" });
    check(ro.status === 200 && /RetailCo/.test(ro.body.answer), "rollout stores behind (copilot)", `${ro.body.mode}, ${(ro.ms / 1000).toFixed(1)} s`);
    const week = new Date().toISOString().slice(0, 10);
    const ts = await get<{ review: unknown[] }>(`/api/office/timesheets?week=${week}`);
    check(Array.isArray(ts.review) && ts.review.length > 0, "timesheet flags to review", `${ts.review?.length ?? 0} entries`);
    const dg = await post<{ mode: string }>("/api/office/digest", {});
    check(dg.status === 200, "daily digest", `${dg.body.mode} in ${(dg.ms / 1000).toFixed(1)} s`);
  }
  console.log(failures ? `\n${failures} check(s) failed` : `\nAll checks passed in ${runs} run(s)`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
