// Shared wrapper for GET /api/office/* routes: office actor check, one Pool per
// request, no caching.
import { NextResponse, type NextRequest } from "next/server";
import { describeError, isTransientDbError, withTransientRetry } from "../db/errors";
import { withDb } from "../db/server";
import type { Db } from "../sync/store-drizzle";
import { resolveOfficeActor, type OfficeActor } from "./auth";

const noStore = { "cache-control": "no-store" };

export async function officeGet(
  request: NextRequest,
  fn: (db: Db, actor: OfficeActor) => Promise<Response | object | null>,
): Promise<Response> {
  try {
    // Reads only, so a transient DB failure is simply retried once (fresh Pool).
    return await withTransientRetry(() => withDb(async (db) => {
      const auth = await resolveOfficeActor(db, request.cookies);
      if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status, headers: noStore });
      const out = await fn(db, auth.actor);
      if (out instanceof Response) return out;
      if (out === null) return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
      return NextResponse.json(out, { headers: noStore });
    }));
  } catch (err) {
    const transient = isTransientDbError(err);
    console.error(`[api/office] ${request.nextUrl.pathname} ${transient ? "database unavailable" : "failed"}:\n${describeError(err)}`);
    return transient
      ? NextResponse.json({ error: "db_unavailable", retryable: true }, { status: 503, headers: { ...noStore, "retry-after": "5" } })
      : NextResponse.json({ error: "internal_error" }, { status: 500, headers: noStore });
  }
}

export const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Office write routes for demo/ops state that is NOT domain data (demo clock,
 * alert handling, SMS demo recipient): domain changes still go through
 * POST /api/sync as events. `allow` restricts roles (403 otherwise).
 */
export async function officePost(
  request: NextRequest,
  allow: (role: OfficeActor["role"]) => boolean,
  fn: (db: Db, actor: OfficeActor, body: unknown) => Promise<Response | object>,
): Promise<Response> {
  let body: unknown = null;
  try {
    const text = await request.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: noStore });
  }
  try {
    return await withDb(async (db) => {
      const auth = await resolveOfficeActor(db, request.cookies);
      if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status, headers: noStore });
      if (!allow(auth.actor.role)) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: noStore });
      const out = await fn(db, auth.actor, body);
      return out instanceof Response ? out : NextResponse.json(out, { headers: noStore });
    });
  } catch (err) {
    const transient = isTransientDbError(err);
    console.error(`[api/office] POST ${request.nextUrl.pathname} failed:\n${describeError(err)}`);
    return NextResponse.json(
      { error: transient ? "db_unavailable" : "internal_error", retryable: transient },
      { status: transient ? 503 : 500, headers: noStore },
    );
  }
}
