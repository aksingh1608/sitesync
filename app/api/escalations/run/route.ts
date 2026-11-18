// Runs the escalation rules on demand (and, from the daily cron, writes
// yesterday's digest). Protected by CRON_SECRET (Bearer), not
// by the demo access gate (lib/access.ts lists it as public), so Vercel Cron
// (GET, daily safety net on Hobby) and scripts (POST) can call it.
import { generateDigest, yesterdayKey } from "@/lib/agents/digest";
import { loadClock } from "@/lib/clock";
import { withDb } from "@/lib/db/server";
import { safeEqual } from "@/lib/access";
import { runEscalations } from "@/lib/escalation/run";
import { describeError } from "@/lib/db/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const noStore = { "cache-control": "no-store" };

async function handle(request: Request, trigger: "cron" | "manual") {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "cron_secret_not_configured" }, { status: 503, headers: noStore });
  const given = request.headers.get("authorization") ?? "";
  if (!safeEqual(given, `Bearer ${secret}`)) return Response.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  try {
    const summary = await withDb((db) => runEscalations(db, { trigger }));
    // The daily cron also writes yesterday's digest (Hobby allows one cron a day).
    let digest: { id: string; day: string; mode: string } | { error: string } | null = null;
    if (trigger === "cron") {
      try {
        digest = await withDb(async (db) => {
          const clock = await loadClock(db);
          const day = yesterdayKey(clock.now);
          const out = await generateDigest(db, { day, now: clock.now, trigger: "cron" });
          return { id: out.id, day, mode: out.content.mode };
        });
      } catch (err) {
        console.error(`[api/escalations/run] digest failed:\n${describeError(err)}`);
        digest = { error: "digest_failed" };
      }
    }
    return Response.json({ ...summary, digest }, { headers: noStore });
  } catch (err) {
    console.error(`[api/escalations/run] failed:\n${describeError(err)}`);
    return Response.json({ error: "run_failed" }, { status: 500, headers: noStore });
  }
}

export const GET = (request: Request) => handle(request, "cron");
export const POST = (request: Request) => handle(request, "manual");
