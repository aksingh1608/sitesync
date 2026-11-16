import { NextResponse } from "next/server";
import { withDb } from "@/lib/db/server";
import { SyncRequestSchema } from "@/lib/sync/protocol";
import { processSync } from "@/lib/sync/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const noStore = { "cache-control": "no-store" };

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: noStore });
  }
  const parsed = SyncRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", issues: parsed.error.issues.slice(0, 10) },
      { status: 400, headers: noStore },
    );
  }

  try {
    const outcome = await withDb((db) => processSync(db, parsed.data, { recordDevice: true }));
    if (!outcome.ok) {
      return NextResponse.json({ error: outcome.error }, { status: outcome.status, headers: noStore });
    }
    return NextResponse.json(outcome.response, { headers: noStore });
  } catch (err) {
    console.error("[api/sync] failed", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: noStore });
  }
}
