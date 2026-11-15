"use client";
// Field app frame: an always-visible sync bar on top and the bottom navigation.
import { ClipboardList, Clock, Mic, User } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { formatClock, useMeta } from "@/components/use-local";
import { sync } from "@/lib/sync/client";
import { cn } from "@/lib/utils";
import { useOnline, usePendingRefs, usePendingUploads } from "./hooks";

const NAV = [
  { href: "/field", label: "Tasks", icon: ClipboardList, match: (p: string) => p === "/field" || p.startsWith("/field/task") || p.startsWith("/field/request") },
  { href: "/field/clock", label: "Clock", icon: Clock, match: (p: string) => p.startsWith("/field/clock") },
  { href: "/field/notes", label: "Notes", icon: Mic, match: (p: string) => p.startsWith("/field/notes") },
  { href: "/field/me", label: "Me", icon: User, match: (p: string) => p.startsWith("/field/me") },
];

export function FieldChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="flex min-h-dvh flex-col bg-slate-100 text-slate-950">
      <SyncBar />
      <main className="mx-auto w-full max-w-xl flex-1 space-y-4 px-4 pt-4 pb-28 text-lg">{children}</main>
      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t-2 border-slate-300 bg-white pb-[env(safe-area-inset-bottom)]"
        aria-label="Main"
      >
        <ul className="mx-auto grid max-w-xl grid-cols-4">
          {NAV.map(({ href, label, icon: Icon, match }) => {
            const active = match(pathname);
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-16 flex-col items-center justify-center gap-0.5 text-sm font-bold",
                    active ? "text-blue-800" : "text-slate-700",
                  )}
                >
                  <Icon className={cn("size-7", active && "stroke-[2.5]")} aria-hidden />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

/** Global sync indicator. Always visible; tap to sync now. */
export function SyncBar() {
  const meta = useMeta();
  const online = useOnline();
  const pending = usePendingRefs(meta?.actorId);
  const uploads = usePendingUploads(meta?.actorId);
  const [busy, setBusy] = useState(false);
  const offline = !online || !!meta?.simulateOffline;
  const last = meta?.lastSyncResult;
  const waiting = pending.count + uploads;

  const tone = offline
    ? "bg-slate-900 text-white"
    : last?.status === "error"
      ? "bg-red-700 text-white"
      : waiting
        ? "bg-amber-400 text-black"
        : "bg-green-700 text-white";
  const text = offline
    ? meta?.simulateOffline
      ? "Offline (simulated)"
      : "Offline"
    : busy
      ? "Syncing…"
      : last?.status === "error"
        ? `Sync failed · retry ${formatClock(last.retryAt)}`
        : meta?.lastSyncAt
          ? `Synced ${formatClock(meta.lastSyncAt)}`
          : "Not synced yet";

  return (
    <button
      type="button"
      onClick={async () => {
        setBusy(true);
        try {
          await sync({ manual: true });
        } finally {
          setBusy(false);
        }
      }}
      className={cn("sticky top-0 z-40 w-full pt-[env(safe-area-inset-top)]", tone)}
      data-testid="sync-bar"
      aria-live="polite"
    >
      <span className="mx-auto flex min-h-12 max-w-xl items-center justify-between gap-2 px-4 text-base font-bold">
        <span data-testid="net-status">{text}</span>
        <span data-testid="pending-count">
          {waiting
            ? `${pending.count} waiting to sync${uploads ? ` · ${uploads} upload${uploads > 1 ? "s" : ""}` : ""}`
            : "All saved"}
        </span>
      </span>
    </button>
  );
}
