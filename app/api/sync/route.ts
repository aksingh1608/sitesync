import { withDb } from "@/lib/db/server";
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
  // A fresh Pool per attempt, so a retry never reuses a broken connection.
  return handleSync(body, (req) => withDb((db) => processSync(db, req, { recordDevice: true })));
}
