// Day 5 end-to-end check against a running server (pnpm build && pnpm start):
//   BASE=http://localhost:3100 pnpm e2e:agents [--fallback]
// Walks the definition of done: dispatch (inject sample -> draft -> approve ->
// task reaches the technician), field report (text note + voice note ->
// transcript/log/material request/urgent safety task -> Day 4 escalation),
// digest (numbers match the board), copilot (3 questions). Writes real demo
// data (reseed afterwards if you want a clean board). --fallback asserts that
// every agent used its fallback (start the server without ANTHROPIC_API_KEY).
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { accessToken } from "@/lib/access";
import { ACTOR_COOKIE, OFFICE_ACTOR_COOKIE } from "@/lib/config";
import { derive } from "@/lib/office/derive";
import { uuidv4 } from "@/lib/uuid";

const BASE = process.env.BASE ?? "http://localhost:3100";
const expectFallback = process.argv.includes("--fallback");
const results: { step: string; ok: boolean; ms?: number; detail?: string }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function record(step: string, ok: boolean, detail?: string, ms?: number) {
  results.push({ step, ok, detail, ms });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${ms !== undefined ? ` (${(ms / 1000).toFixed(1)} s)` : ""}${detail ? `\n      ${detail}` : ""}`);
}

async function main() {
  const code = process.env.DEMO_ACCESS_CODE;
  const access = code ? `sitesync_access=${await accessToken(code)}` : "";
  const people = ((await (await fetch(`${BASE}/api/people`, { headers: { cookie: access } })).json()) as { people: { id: string; name: string; role: string; trade: string }[] }).people;
  const by = (role: string, trade?: string) => people.find((p) => p.role === role && (!trade || p.trade === trade))!;
  const coord = by("coordinator");
  const manager = by("manager");
  const tech = by("technician", "electrical");
  const office = (actor: string) => ({ cookie: `${access}; ${OFFICE_ACTOR_COOKIE}=${actor}`, "content-type": "application/json" });
  const field = (actor: string) => ({ cookie: `${access}; ${ACTOR_COOKIE}=${actor}`, "content-type": "application/json" });
  const get = async <T>(path: string, actor = coord.id) => (await (await fetch(`${BASE}${path}`, { headers: office(actor) })).json()) as T;
  const post = async <T>(path: string, body: unknown, actor = coord.id) => {
    const t0 = Date.now();
    const res = await fetch(`${BASE}${path}`, { method: "POST", headers: office(actor), body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as T, ms: Date.now() - t0 };
  };
  const sync = async (actor: string, events: unknown[]) => {
    const res = await fetch(`${BASE}/api/sync`, {
      method: "POST",
      headers: field(actor),
      body: JSON.stringify({ deviceId: "e2e-phone", actorId: actor, cursor: null, events, pull: events.length === 0 }),
    });
    return (await res.json()) as {
      accepted: string[];
      rejected: { reason: string }[];
      changes: { tasks: { id: string; title: string; source: string }[]; field_notes: { id: string; transcript: string | null; report: { mode: string; createdTasks: { id: string; title: string; kind: string; priority: string }[]; transcriptError?: string } | null }[] };
    };
  };
  const runs = async (agent: string) => (await get<{ runs: { status: string; latencyMs: number; costUsd: number | null; subjectId: string | null; tokensIn: number | null; tokensOut: number | null }[] }>(`/api/office/agents?agent=${agent}`)).runs;
  const modeOk = (mode: string) => (expectFallback ? mode === "fallback" : mode === "ai");

  // 1. Dispatch ------------------------------------------------------------
  const { samples } = await get<{ samples: string[] }>("/api/office/dispatch");
  const d = await post<{ draftId: string; mode: string; draft: { siteId: string | null; trade: string; priority: string; suggestedAssigneeId: string | null; title: string; reasoning: string }; notes: string[] }>(
    "/api/office/dispatch",
    { text: samples[0] },
  );
  const assignee = people.find((p) => p.id === d.body.draft?.suggestedAssigneeId);
  record(
    "dispatch: sample request -> draft",
    d.status === 200 && modeOk(d.body.mode) && !!d.body.draft.siteId && !!assignee && d.ms < 20_000,
    `${d.body.mode}: "${d.body.draft?.title}" · trade ${d.body.draft?.trade} · ${d.body.draft?.priority} · assignee ${assignee?.name} (${assignee?.trade}) · ${d.body.draft?.reasoning}${d.body.notes?.length ? ` · notes: ${d.body.notes.join("; ")}` : ""}`,
    d.ms,
  );
  const a = await post<{ ok: boolean; taskId: string }>("/api/office/dispatch/decide", { draftId: d.body.draftId, decision: "approve", deviceId: "web-e2e" });
  const pulled = assignee ? await sync(assignee.id, []) : null;
  const reached = pulled?.changes.tasks.find((t) => t.id === a.body.taskId);
  record("dispatch: approve -> task reaches the technician's pull", a.status === 200 && reached?.source === "dispatch_agent", reached ? `${reached.title} (source ${reached.source})` : JSON.stringify(a.body));
  const twice = await post("/api/office/dispatch/decide", { draftId: d.body.draftId, decision: "approve" });
  record("dispatch: second approve is refused", twice.status === 409);
  const r2 = await post<{ draftId: string }>("/api/office/dispatch", { text: samples[1] });
  const noReason = await post("/api/office/dispatch/decide", { draftId: r2.body.draftId, decision: "reject", reason: "" });
  const rej = await post("/api/office/dispatch/decide", { draftId: r2.body.draftId, decision: "reject", reason: "Customer already called it in" });
  record("dispatch: reject needs a reason", noReason.status === 400 && rej.status === 200);

  // 2. Field report (text note, then a voice note) -------------------------
  const sentence = "Finished the north lot fixtures, we need 40 more LED panels, and there's an exposed wire near the loading dock";
  const siteId = (await get<{ sites: { id: string; name: string }[] }>("/api/office/snapshot")).sites.find((s) => /Northfield/.test(s.name))!.id;
  const noteId = uuidv4();
  const t0 = Date.now();
  const s1 = await sync(tech.id, [
    { id: uuidv4(), type: "note.created", actorId: tech.id, deviceId: "e2e-phone", clientTs: new Date().toISOString(), payload: { noteId, siteId, kind: "text", text: sentence } },
  ]);
  type Detail = { escalations: { rule: string; level: number; status: string; personId: string }[] };
  type Report = { mode: string; createdTasks: { id: string; title: string; kind: string; priority: string }[]; transcriptError?: string };
  let report: Report | null = null;
  for (let i = 0; i < 30 && !report; i++) {
    await sleep(1000);
    // The author's own pull carries the note with the agent's log on it.
    report = (await sync(tech.id, [])).changes.field_notes.find((n) => n.id === noteId)?.report ?? null;
  }
  const created = report?.createdTasks ?? [];
  const ms = Date.now() - t0;
  const safety = created.find((c) => c.priority === "urgent");
  const material = created.find((c) => c.kind === "material_request");
  record(
    "report: text note -> log + material request + urgent safety task",
    s1.accepted.length === 1 && !!report && modeOk(report.mode) && !!safety && !!material,
    `${report?.mode}: ${created.map((c) => `${c.title} [${c.kind}, ${c.priority}]`).join(" | ")}`,
    ms,
  );
  if (safety) {
    let esc: Detail["escalations"] = [];
    for (let i = 0; i < 10 && !esc.length; i++) {
      esc = (await get<Detail>(`/api/office/tasks/${safety.id}`)).escalations;
      if (!esc.length) await sleep(1000);
    }
    record("report: Day 4 escalation applies to the safety task", esc.some((e) => e.rule === "ack"), esc.map((e) => `${e.rule} L${e.level} ${e.status}`).join(", "));
  }

  // Voice note: upload a tiny audio file; transcription runs after the upload.
  const vNote = uuidv4();
  const mediaId = uuidv4();
  await sync(tech.id, [
    { id: uuidv4(), type: "note.created", actorId: tech.id, deviceId: "e2e-phone", clientTs: new Date().toISOString(), payload: { noteId: vNote, siteId, kind: "voice", mediaId } },
  ]);
  const form = new FormData();
  form.set("mediaId", mediaId);
  form.set("noteId", vNote);
  form.set("actorId", tech.id);
  form.set("durationSec", "3");
  form.set("file", new Blob([new Uint8Array(2048)], { type: "audio/webm" }), "note.webm");
  const up = await fetch(`${BASE}/api/media`, { method: "POST", headers: { cookie: field(tech.id).cookie }, body: form });
  let vRun: Awaited<ReturnType<typeof runs>>[number] | undefined;
  for (let i = 0; i < 20 && !vRun; i++) {
    await sleep(1000);
    vRun = (await runs("report_agent")).find((r) => r.subjectId === vNote && r.status !== "running");
  }
  record("report: voice note upload -> agent run (transcribe, else recorded fallback)", up.status === 200 && !!vRun, `upload ${up.status}; run ${vRun?.status} ${vRun ? `${(vRun.latencyMs / 1000).toFixed(1)} s` : ""}`);

  // 3. Digest ----------------------------------------------------------------
  const g = await post<{ id: string; day: string; mode: string }>("/api/office/digest", {});
  const list = await get<{ digests: { id: string; content: { mode: string; numbers: { branch: Record<string, number> }; check: { ok: boolean } } }[] }>("/api/office/digest");
  const dig = list.digests.find((x) => x.id === g.body.id)!;
  const snap = await get<Parameters<typeof derive>[0]>("/api/office/snapshot");
  const counts = derive(snap).counts;
  const b = dig?.content.numbers.branch ?? {};
  const match = b.blocked === counts.blocked && b.overdue === counts.overdue && b.notAcknowledged === counts.unacked && b.openMaterialRequests === counts.materials && b.clockedInNow === counts.clockedIn;
  record(
    "digest: numbers match the board",
    g.status === 200 && match && modeOk(dig.content.mode),
    `${dig?.content.mode}, check ${dig?.content.check.ok ? "ok" : "failed"} · board blocked ${counts.blocked}/${b.blocked}, overdue ${counts.overdue}/${b.overdue}, unacked ${counts.unacked}/${b.notAcknowledged}, materials ${counts.materials}/${b.openMaterialRequests}, clocked in ${counts.clockedIn}/${b.clockedInNow}`,
    g.ms,
  );
  const sent = await post<{ managers: number; subscriptions: number; delivered: number }>("/api/office/digest/send", { digestId: g.body.id });
  record("digest: send to manager", sent.status === 200 && sent.body.managers >= 1, JSON.stringify(sent.body));

  // 4. Copilot ---------------------------------------------------------------
  for (const q of ["Who is at the hospital job and what's blocked?", "Which rollout stores are behind?", "Who hasn't acknowledged urgent tasks today?"]) {
    const c = await post<{ answer: string; citations: unknown[]; mode: string; toolCalls: string[] }>("/api/office/copilot", { question: q });
    const links = (c.body.answer?.match(/\]\(\/office\//g) ?? []).length;
    record(`copilot: ${q}`, c.status === 200 && modeOk(c.body.mode) && links > 0, `${c.body.mode} · tools ${c.body.toolCalls?.join(",")} · ${links} links\n      ${c.body.answer?.replace(/\n/g, "\n      ")}`, c.ms);
  }
  const hr = people.find((p) => p.role === "hr")!;
  const hrAsk = await post<{ toolCalls: string[]; answer: string }>("/api/office/copilot", { question: "Which rollout stores are behind?" }, hr.id);
  record("copilot: HR has no rollout tool", hrAsk.status === 200 && !hrAsk.body.toolCalls.includes("getRolloutStatus"), hrAsk.body.answer.slice(0, 160));
  void manager;

  // Costs ----------------------------------------------------------------------
  for (const agent of ["dispatch_agent", "report_agent", "digest_agent", "ops_copilot"]) {
    const rs = (await runs(agent)).filter((r) => r.status === "ok" || r.status === "fallback").slice(0, 10);
    const lat = rs.map((r) => r.latencyMs).sort((x, y) => x - y);
    const cost = rs.map((r) => r.costUsd ?? 0);
    console.log(`  ${agent}: ${rs.length} recent runs · median ${((lat[Math.floor(lat.length / 2)] ?? 0) / 1000).toFixed(1)} s · max ${((lat.at(-1) ?? 0) / 1000).toFixed(1)} s · avg cost $${(cost.reduce((s, x) => s + x, 0) / Math.max(1, cost.length)).toFixed(4)} · statuses ${[...new Set(rs.map((r) => r.status))].join("/")}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
