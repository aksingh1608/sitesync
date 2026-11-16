// Office dashboard (coordinator, HR, manager). Online-only, desktop layout.
// Technicians and foremen are sent to /field. Demo mode: no real login.
import { asc, inArray } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { OfficeShell } from "@/components/office/shell";
import { people } from "@/lib/db/schema";
import { withDb } from "@/lib/db/server";
import { OFFICE_ROLES } from "@/lib/domain";
import { resolveOfficeActor } from "@/lib/office/auth";

export const metadata = { title: "Office" };
export const dynamic = "force-dynamic";

export default async function Layout({ children }: LayoutProps<"/office">) {
  const jar = await cookies();
  const { auth, office } = await withDb(async (db) => ({
    auth: await resolveOfficeActor(db, jar),
    office: await db
      .select({ id: people.id, name: people.name, role: people.role })
      .from(people)
      .where(inArray(people.role, [...OFFICE_ROLES]))
      .orderBy(asc(people.name)),
  }));
  if (!auth.ok && auth.error === "office_only") redirect("/field");
  return (
    <OfficeShell actor={auth.ok ? auth.actor : null} officePeople={office}>
      {children}
    </OfficeShell>
  );
}
