import { after } from "next/server";
import { withDb } from "@/lib/db/server";
import { afterSyncAgents } from "@/lib/agents/hooks";
import { handleSync } from "@/lib/sync/http";
import { clientIp, hit, limitsFor } from "@/lib/ratelimit";
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
    const out = await withDb(async (db) => {
      const limited = await hit(db, [limitsFor("syncDevice", req.deviceId), limitsFor("syncIp", clientIp(request.headers))]);
      if (!limited.ok) return { ok: false as const, status: 429 as const, error: "rate_limited" as const, retryAfterSec: limited.retryAfterSec };
      return processSync(db, req, { recordDevice: true });
    });
    if (out.ok) accepted = out.response.accepted.length;
    return out;
  });
  // After the response (never slows or fails the sync): the field report agent
  // for notes that just arrived, then the escalation rules. A sync that changed
  // something runs them right away; an idle one is throttled.
  after(() => afterSyncAgents(withDb, { trigger: "sync", throttleEscalations: accepted === 0 }));
  return res;
}
