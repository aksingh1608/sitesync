// Who is using /office (demo mode, no real login). The office identity has its
// own cookie so one browser can run /field as a technician and /office as a
// coordinator side by side; it falls back to the field actor cookie.
import { eq } from "drizzle-orm";
import { ACTOR_COOKIE, OFFICE_ACTOR_COOKIE } from "../config";
import { people } from "../db/schema";
import { isOfficeRole, type Role } from "../domain";
import type { Db } from "../sync/store-drizzle";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CookieReader = { get(name: string): { value: string } | undefined };

export function officeActorId(cookies: CookieReader): string | null {
  for (const name of [OFFICE_ACTOR_COOKIE, ACTOR_COOKIE]) {
    const v = cookies.get(name)?.value;
    if (v && UUID.test(v)) return v;
  }
  return null;
}

export type OfficeActor = { id: string; name: string; role: Role; trade: string };
export type OfficeAuth =
  | { ok: true; actor: OfficeActor }
  | { ok: false; status: 401 | 403; error: "pick_a_person" | "unknown_actor" | "office_only" };

export async function resolveOfficeActor(db: Db, cookies: CookieReader): Promise<OfficeAuth> {
  const id = officeActorId(cookies);
  if (!id) return { ok: false, status: 401, error: "pick_a_person" };
  const [p] = await db.select().from(people).where(eq(people.id, id));
  if (!p || !p.active) return { ok: false, status: 401, error: "unknown_actor" };
  if (!isOfficeRole(p.role)) return { ok: false, status: 403, error: "office_only" };
  return { ok: true, actor: { id: p.id, name: p.name, role: p.role, trade: p.trade } };
}
