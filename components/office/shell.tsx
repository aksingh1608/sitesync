"use client";
import { BarChart3, CalendarClock, ClipboardList, LayoutGrid, MessageSquare, Package, Store } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { APP_NAME, COMPANY_NAME, OFFICE_ACTOR_COOKIE } from "@/lib/config";
import type { Role } from "@/lib/domain";
import type { OfficeActor } from "@/lib/office/auth";
import { cn } from "@/lib/utils";
import { SnapshotProvider } from "./data";
import { DemoClockBar } from "./escalations";
import { capabilities } from "./ui";

const NAV = [
  { href: "/office", label: "Board", icon: LayoutGrid, show: (r: Role) => r !== "hr" },
  { href: "/office/tasks", label: "Tasks", icon: ClipboardList, show: () => true },
  { href: "/office/tasks/materials", label: "Material requests", icon: Package, show: (r: Role) => r !== "hr", sub: true },
  { href: "/office/rollouts", label: "Rollouts", icon: Store, show: (r: Role) => r !== "hr" },
  { href: "/office/timesheets", label: "Timesheets", icon: CalendarClock, show: () => true },
  { href: "/office/sms", label: "SMS log", icon: MessageSquare, show: (r: Role) => r !== "hr" },
  { href: "/office/team", label: "Team", icon: BarChart3, show: () => true },
];

const ROLE_LABEL: Record<string, string> = { coordinator: "Coordinator", hr: "HR", manager: "Manager" };

export function setOfficeActorCookie(id: string) {
  document.cookie = `${OFFICE_ACTOR_COOKIE}=${id}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

export function OfficeShell({
  actor,
  officePeople,
  children,
}: {
  actor: OfficeActor | null;
  officePeople: { id: string; name: string; role: Role }[];
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const switchTo = (id: string) => {
    setOfficeActorCookie(id);
    router.refresh();
  };

  return (
    <div className="flex min-h-screen w-full">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r bg-sidebar p-3 text-sidebar-foreground md:flex">
        <div className="px-2 pb-4">
          <div className="text-base font-semibold">{APP_NAME} Office</div>
          <div className="text-xs text-muted-foreground">{COMPANY_NAME} · fictional</div>
        </div>
        <nav className="flex flex-col gap-0.5" aria-label="Office">
          {actor &&
            NAV.filter((n) => n.show(actor.role)).map((n) => {
              const active = n.href === "/office" ? pathname === "/office" : pathname === n.href || (pathname.startsWith(n.href + "/") && !NAV.some((m) => m.href !== n.href && m.href.startsWith(n.href) && pathname.startsWith(m.href)));
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent",
                    n.sub && "ml-4 text-[0.8rem]",
                    active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
                  )}
                >
                  <n.icon className="size-4" />
                  {n.label}
                </Link>
              );
            })}
        </nav>
        <div className="mt-auto space-y-1 px-2 text-xs text-muted-foreground">
          <Link href="/field" className="block hover:underline">Open the field app</Link>
          <Link href="/" className="block hover:underline">Demo people picker</Link>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b bg-background/95 px-4 py-2 backdrop-blur">
          <div className="md:hidden font-semibold">{APP_NAME} Office</div>
          <nav className="flex gap-2 overflow-x-auto text-sm md:hidden">
            {actor && NAV.filter((n) => n.show(actor.role) && !n.sub).map((n) => (
              <Link key={n.href} href={n.href} className="whitespace-nowrap underline-offset-4 hover:underline">{n.label}</Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 text-sm">
            <span className="rounded border border-amber-400 bg-amber-50 px-1.5 py-0.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
              Demo: no real login
            </span>
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground">Acting as</span>
              <select
                className="h-8 rounded-md border bg-background px-2 text-sm"
                value={actor?.id ?? ""}
                onChange={(e) => e.target.value && switchTo(e.target.value)}
                data-testid="office-actor"
              >
                {!actor && <option value="">Pick a person…</option>}
                {officePeople.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({ROLE_LABEL[p.role] ?? p.role})
                  </option>
                ))}
              </select>
            </label>
          </div>
        </header>
        <main className="min-w-0 flex-1 p-4">
          {actor ? (
            <SnapshotProvider key={actor.id} actorId={actor.id}>
              <DemoClockBar />
              <RoleNote role={actor.role} />
              {children}
            </SnapshotProvider>
          ) : (
            <div className="mx-auto max-w-md space-y-3 pt-16 text-center">
              <h1 className="text-xl font-semibold">Who is using the office dashboard?</h1>
              <p className="text-sm text-muted-foreground">Pick a coordinator, HR person or manager at the top right.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function RoleNote({ role }: { role: Role }) {
  const c = capabilities(role);
  const notes = [!c.editTasks && "tasks are read-only", !c.reviewTime && "timesheet approval is HR's"].filter(Boolean);
  if (!notes.length) return null;
  return (
    <p className="mb-3 text-xs text-muted-foreground">
      {ROLE_LABEL[role]} view: {notes.join("; ")}.
    </p>
  );
}
