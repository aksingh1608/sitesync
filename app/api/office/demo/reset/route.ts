// POST /api/office/demo/reset (managers): wipe and reseed the demo relative to
// now. The seed truncates escalations, the SMS log, agent runs, dispatch
// drafts and digests, and resets the demo clock. Phones must then use
// "Reset this device" (their cached copy belongs to the old data).
import { NextResponse, type NextRequest } from "next/server";
import { reseedWithRetry } from "@/db/seed-fast";
import { resolveOfficeActor } from "@/lib/office/auth";
import { openDb, withDb } from "@/lib/db/server";
import { describeError } from "@/lib/db/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const noStore = { "cache-control": "no-store" };

export async function POST(request: NextRequest) {
  try {
    const auth = await withDb((db) => resolveOfficeActor(db, request.cookies));
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status, headers: noStore });
    if (auth.actor.role !== "manager") return NextResponse.json({ error: "managers_only" }, { status: 403, headers: noStore });
    const started = Date.now();
    const summary = await reseedWithRetry(openDb);
    return NextResponse.json({ ok: true, seconds: Math.round((Date.now() - started) / 100) / 10, summary }, { headers: noStore });
  } catch (err) {
    console.error(`[api/office/demo/reset] failed:\n${describeError(err)}`);
    return NextResponse.json({ error: "reset_failed", retryable: true }, { status: 503, headers: noStore });
  }
}
