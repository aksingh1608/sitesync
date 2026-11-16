// Runs the escalation rules on demand. Protected by CRON_SECRET (Bearer), not
// by the demo access gate (lib/access.ts lists it as public), so Vercel Cron
// (GET, daily safety net on Hobby) and scripts (POST) can call it.
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
    return Response.json(summary, { headers: noStore });
  } catch (err) {
    console.error(`[api/escalations/run] failed:\n${describeError(err)}`);
    return Response.json({ error: "run_failed" }, { status: 500, headers: noStore });
  }
}

export const GET = (request: Request) => handle(request, "cron");
export const POST = (request: Request) => handle(request, "manual");
