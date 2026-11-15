"use client";
import Link from "next/link";
import { formatClock, formatTime } from "@/components/use-local";
import type { ReceiptRow, TaskRow } from "@/lib/sync/reducers";
import { cn } from "@/lib/utils";
import { Pill, PRIORITY_STYLE, WaitingMarker } from "./ui";

export type ReceiptStage = "not sent" | "sent" | "delivered" | "seen" | "acknowledged";
export function receiptStage(r: ReceiptRow | undefined): ReceiptStage {
  if (!r) return "not sent";
  if (r.acknowledgedAt) return "acknowledged";
  if (r.seenAt) return "seen";
  if (r.deliveredAt) return "delivered";
  return "sent";
}

export const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};
const STATUS_STYLE: Record<string, string> = {
  open: "bg-white text-slate-900 border border-slate-500",
  in_progress: "bg-blue-100 text-blue-950 border border-blue-700",
  blocked: "bg-red-100 text-red-950 border border-red-700",
  done: "bg-green-100 text-green-950 border border-green-700",
  cancelled: "bg-slate-200 text-slate-700 border border-slate-400",
};

export function StatusPill({ status }: { status: string }) {
  return <Pill className={STATUS_STYLE[status]}>{STATUS_LABEL[status] ?? status}</Pill>;
}

export function TaskCard({
  task,
  siteName,
  receipt,
  overdue,
  pending,
  showDate,
}: {
  task: TaskRow;
  siteName: string | undefined;
  receipt: ReceiptRow | undefined;
  overdue: boolean;
  pending: boolean;
  showDate: boolean;
}) {
  const stage = receiptStage(receipt);
  return (
    <li>
      <Link
        href={`/field/task?id=${task.id}`}
        className={cn(
          "block min-h-16 space-y-2 rounded-xl border-2 bg-white p-4 active:bg-slate-50",
          overdue ? "border-red-700" : "border-slate-300",
        )}
        data-testid="task-item"
      >
        <div className="flex items-start justify-between gap-3">
          <span className={cn("text-lg leading-snug font-bold", task.status === "done" && "line-through")}>{task.title}</span>
          {task.priority !== "normal" && <Pill className={PRIORITY_STYLE[task.priority]}>{task.priority}</Pill>}
        </div>
        <div className="text-base text-slate-800">{siteName ?? "Unknown site"}</div>
        <div className="flex flex-wrap items-center gap-2 text-base">
          <span className={cn("font-semibold", overdue ? "text-red-700" : "text-slate-900")}>
            {task.dueAt ? `${overdue ? "Overdue · " : ""}Due ${showDate ? formatTime(task.dueAt) : formatClock(task.dueAt)}` : "No due date"}
          </span>
          <StatusPill status={task.status} />
          {stage !== "acknowledged" && stage !== "not sent" && (
            <Pill className="border border-blue-700 bg-white text-blue-900">Not acknowledged</Pill>
          )}
          {pending && <WaitingMarker />}
        </div>
      </Link>
    </li>
  );
}
