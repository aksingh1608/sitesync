"use client";
import { X } from "lucide-react";
import Link from "next/link";
import { useEffect, type ReactNode, type SelectHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { BRANCH_TIMEZONE } from "@/lib/config";
import { canManageRollouts, canManageTasks, canReviewTime, type Role } from "@/lib/domain";
import { RECEIPT_STAGES, receiptStage, type ReceiptStage } from "@/lib/office/rules";
import { formatInZone } from "@/lib/time";
import { cn } from "@/lib/utils";

/** What the current role may do (the server enforces the same rules in the reducers). */
export function capabilities(role: Role) {
  return {
    editTasks: canManageTasks(role),
    moveStages: canManageRollouts(role),
    materials: canManageRollouts(role),
    reviewTime: canReviewTime(role),
  };
}

// --- formatting (always branch time) ---------------------------------------
export const fmtDateTime = (d: string | Date | null | undefined) =>
  d ? formatInZone(d, BRANCH_TIMEZONE, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
export const fmtTime = (d: string | Date | null | undefined) =>
  d ? formatInZone(d, BRANCH_TIMEZONE, { hour: "numeric", minute: "2-digit" }) : "—";
export const fmtDay = (d: string | Date | null | undefined) =>
  d ? formatInZone(d, BRANCH_TIMEZONE, { weekday: "short", month: "short", day: "numeric" }) : "—";

export const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};
export const KIND_LABEL: Record<string, string> = {
  task: "Task",
  follow_up: "Follow-up",
  service_call: "Service call",
  material_request: "Material request",
};
export const WORKER_STATUS_LABEL: Record<string, string> = { on_site: "On site", lunch: "Lunch", traveling: "Traveling", off: "Off" };
export const MATERIAL_LABEL: Record<string, string> = { requested: "Requested", approved: "Approved", ordered: "Ordered", delivered: "Delivered" };

export function Pill({ tone = "slate", children, className }: { tone?: "slate" | "red" | "amber" | "green" | "blue"; children: ReactNode; className?: string }) {
  const tones = {
    slate: "bg-muted text-foreground",
    red: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
    amber: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
    green: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200",
    blue: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  };
  return <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap", tones[tone], className)}>{children}</span>;
}

export const statusTone = (s: string) => (s === "blocked" ? "red" : s === "in_progress" ? "blue" : s === "done" ? "green" : "slate") as "red" | "blue" | "green" | "slate";
export const priorityTone = (p: string) => (p === "urgent" ? "red" : p === "high" ? "amber" : "slate") as "red" | "amber" | "slate";

type Receipt = { sentAt: string; deliveredAt: string | null; seenAt: string | null; acknowledgedAt: string | null };
const STAGE_SHORT: Record<ReceiptStage, string> = { sent: "Sent", delivered: "Delivered", seen: "Seen", acknowledged: "Acknowledged" };

/** Sent -> Delivered -> Seen -> Acknowledged, timestamps on hover. */
export function ReceiptChain({ receipt, warn }: { receipt: Receipt | null | undefined; warn?: boolean }) {
  const reached = RECEIPT_STAGES.indexOf(receiptStage(receipt));
  const at: Record<ReceiptStage, string | null> = {
    sent: receipt?.sentAt ?? null,
    delivered: receipt?.deliveredAt ?? null,
    seen: receipt?.seenAt ?? null,
    acknowledged: receipt?.acknowledgedAt ?? null,
  };
  return (
    <span className="inline-flex items-center gap-0.5" data-testid="receipt-chain" data-stage={RECEIPT_STAGES[reached]}>
      {RECEIPT_STAGES.map((s, i) => (
        <span key={s} className="inline-flex items-center">
          {i > 0 && <span className={cn("mx-0.5 h-px w-2", i <= reached ? "bg-green-600" : "bg-border")} />}
          <span
            title={`${STAGE_SHORT[s]}: ${at[s] ? fmtDateTime(at[s]) : "not yet"}`}
            className={cn(
              "rounded px-1 text-[0.7rem] leading-5",
              i <= reached ? "bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200" : "bg-muted text-muted-foreground",
              warn && i === 3 && "bg-amber-200 text-amber-950 dark:bg-amber-900 dark:text-amber-100",
            )}
          >
            {STAGE_SHORT[s]}
          </span>
        </span>
      ))}
    </span>
  );
}

export function Select({ label, className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  return (
    <label className={cn("flex flex-col gap-0.5 text-xs text-muted-foreground", className)}>
      {label}
      <select className="h-8 rounded-md border bg-background px-2 text-sm text-foreground" {...rest}>
        {children}
      </select>
    </label>
  );
}

export const inputClass = "h-8 w-full rounded-md border bg-background px-2 text-sm";

export function Kpi({ label, value, href, tone, testId }: { label: string; value: number | string; href: string; tone?: "red" | "amber"; testId?: string }) {
  return (
    <Link
      href={href}
      data-testid={testId}
      className={cn(
        "flex min-w-36 flex-1 flex-col rounded-lg border p-3 hover:bg-muted",
        tone === "red" && Number(value) > 0 && "border-red-300 bg-red-50 dark:bg-red-950/40",
        tone === "amber" && Number(value) > 0 && "border-amber-300 bg-amber-50 dark:bg-amber-950/40",
      )}
    >
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </Link>
  );
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3">
      <h1 className="text-xl font-semibold">{title}</h1>
      <div className="ml-auto flex flex-wrap items-center gap-3 text-sm">{children}</div>
    </div>
  );
}

export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open || typeof document === "undefined") return null;
  // Portal to <body>: a drawer opened from the sticky header (backdrop-blur creates a
  // containing block for fixed children) would otherwise be clipped to the header strip.
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" data-testid="drawer">
      <button className="absolute inset-0 bg-black/30" aria-label="Close" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-xl flex-col overflow-y-auto border-l bg-background p-4 shadow-xl">
        <div className="mb-3 flex items-start gap-2">
          <div className="min-w-0 flex-1 text-lg font-semibold">{title}</div>
          <button onClick={onClose} className="rounded p-1 hover:bg-muted" aria-label="Close">
            <X className="size-5" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-2 py-1 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
      {error}
    </p>
  );
}
