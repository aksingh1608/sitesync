// Office dashboard (coordinator, HR, manager). Online-only, desktop layout.
// Technicians and foremen are sent to /field. Demo mode: no real login.
import { asc, inArray } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { OfficeShell } from "@/components/office/shell";
import { describeError, withTransientRetry } from "@/lib/db/errors";
import { people } from "@/lib/db/schema";
import { withDb } from "@/lib/db/server";
import { OFFICE_ROLES } from "@/lib/domain";
import { resolveOfficeActor } from "@/lib/office/auth";

export const metadata = { title: "Office" };
export const dynamic = "force-dynamic";

export default async function Layout({ children }: LayoutProps<"/office">) {
  const jar = await cookies();
  let loaded;
  try {
    // Read-only, so a dropped Neon connection is retried once on a fresh Pool.
    loaded = await withTransientRetry(() =>
      withDb(async (db) => ({
        auth: await resolveOfficeActor(db, jar),
        office: await db
          .select({ id: people.id, name: people.name, role: people.role })
          .from(people)
          .where(inArray(people.role, [...OFFICE_ROLES]))
          .orderBy(asc(people.name)),
      })),
    );
  } catch (err) {
    console.error(`[office/layout] database unavailable:\n${describeError(err)}`);
    return (
      <main className="mx-auto max-w-md space-y-3 p-8 pt-24 text-center" data-testid="office-unavailable">
        <h1 className="text-xl font-semibold">The dashboard can&apos;t reach the database</h1>
        <p className="text-sm text-muted-foreground">This is usually brief. Reload in a few seconds. Field phones keep working offline and sync later.</p>
        <a href="" className="inline-block rounded-md border px-3 py-1.5 text-sm hover:bg-muted">Reload</a>
      </main>
    );
  }
  const { auth, office } = loaded;
  if (!auth.ok && auth.error === "office_only") redirect("/field");
  return (
    <OfficeShell actor={auth.ok ? auth.actor : null} officePeople={office}>
      {children}
    </OfficeShell>
  );
}
