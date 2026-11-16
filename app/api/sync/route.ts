import { after } from "next/server";
import { withDb } from "@/lib/db/server";
import { runEscalationsSafe } from "@/lib/escalation/run";
import { handleSync } from "@/lib/sync/http";
import { processSync } from "@/lib/sync/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  let accepted = 0;
  // A fresh Pool per attempt, so a retry never reuses a broken connection.
  const res = await handleSync(body, async (req) => {
    const out = await withDb((db) => processSync(db, req, { recordDevice: true }));
    if (out.ok) accepted = out.response.accepted.length;
    return out;
  });
  // Escalation rules after the response (never slows or fails the sync). A sync
  // that changed something runs them right away; an idle one is throttled.
  after(() => runEscalationsSafe(withDb, { trigger: "sync", throttle: accepted === 0 }));
  return res;
}
