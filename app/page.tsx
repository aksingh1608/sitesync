"use client";
// Demo role picker. There is no real login: picking a person sets the actor
// in IndexedDB and a cookie. The API only checks that the actor exists and is active.
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useMeta } from "@/components/use-local";
import { LogoMark } from "@/components/logo";
import { APP_NAME, COMPANY_NAME } from "@/lib/config";
import { setMeta, type DirectoryEntry } from "@/lib/db/local";
import { ROLES, isOfficeRole, type Role } from "@/lib/domain";
import { setActor, sync } from "@/lib/sync/client";
import { setOfficeActorCookie } from "@/components/office/shell";

const ROLE_LABEL: Record<Role, string> = {
  technician: "Technicians",
  foreman: "Foremen",
  coordinator: "Coordinators",
  hr: "HR",
  manager: "Managers",
};

export default function RolePicker() {
  const meta = useMeta();
  const router = useRouter();
  const [fetched, setFetched] = useState<DirectoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/people", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const { people } = (await r.json()) as { people: DirectoryEntry[] };
        setFetched(people);
        await setMeta({ directory: people });
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const people = fetched ?? meta?.directory ?? [];

  async function pick(p: DirectoryEntry) {
    if (isOfficeRole(p.role as Role)) {
      // The office has its own identity cookie, so this browser can keep a
      // field worker on /field at the same time.
      setOfficeActorCookie(p.id);
      router.push("/office");
      return;
    }
    await setActor(p.id);
    void sync({ manual: true });
    router.push("/field");
  }

  return (
    <main className="mx-auto w-full max-w-xl p-4 space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <LogoMark className="size-9" />
          {APP_NAME}
        </h1>
        <p className="text-sm text-muted-foreground">{COMPANY_NAME} · fictional demo data</p>
      </header>

      <div
        role="note"
        className="rounded-md border border-amber-400 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
      >
        <strong>Demo mode, no real login.</strong> Pick a person to act as them on this device. Office people open
        the dashboard (/office); field people open the phone app (/field). One browser can run both.
      </div>

      {error && !people.length && (
        <p className="text-sm text-destructive">Could not load people ({error}). Connect once to load the list.</p>
      )}
      {error && people.length > 0 && (
        <p className="text-xs text-muted-foreground">Offline: showing the list saved on this device.</p>
      )}

      {ROLES.map((role) => {
        const group = people.filter((p) => p.role === role);
        if (!group.length) return null;
        return (
          <Card key={role}>
            <CardHeader>
              <CardTitle className="text-base">{ROLE_LABEL[role]}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {group.map((p) => (
                <button
                  key={p.id}
                  onClick={() => pick(p)}
                  className="flex w-full items-center justify-between rounded-md border p-3 text-left hover:bg-muted"
                  data-testid={`pick-${p.id}`}
                >
                  <span className="font-medium">{p.name}</span>
                  <span className="flex gap-2">
                    {meta?.actorId === p.id && <Badge>current</Badge>}
                    <Badge variant="outline">{p.trade}</Badge>
                  </span>
                </button>
              ))}
            </CardContent>
          </Card>
        );
      })}
    </main>
  );
}
