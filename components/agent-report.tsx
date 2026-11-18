"use client";
// The field report agent's output on a note: transcript, structured log and
// the tasks it created. Shared by the field Notes screen and the office task
// drawer (each passes its own link for a task).
import Link from "next/link";
import type { NoteReport } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

const FALLBACK = "Fallback (AI unavailable)";

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="font-semibold">{title}</div>
      <ul className="list-disc pl-5">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

const qty = (m: { item: string; qty?: number | null }) => (m.qty ? `${m.qty} × ${m.item}` : m.item);

export function AgentReport({
  transcript,
  report,
  processedAt,
  taskHref,
  className,
  pendingLabel,
}: {
  transcript: string | null;
  report: NoteReport | null;
  processedAt: Date | string | null;
  taskHref: (taskId: string) => string;
  className?: string;
  /** Shown while the agent has not read the note yet (null = show nothing). */
  pendingLabel?: string | null;
}) {
  if (!processedAt || !report) {
    return pendingLabel ? <p className={cn("text-sm text-slate-600", className)}>{pendingLabel}</p> : null;
  }
  return (
    <div className={cn("space-y-2 rounded-lg border border-violet-300 bg-violet-50 p-2 text-sm text-violet-950 dark:bg-violet-950/40 dark:text-violet-100", className)} data-testid="agent-report">
      <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide">
        <span>Report agent</span>
        <span className={cn("rounded px-1.5 py-0.5 normal-case", report.mode === "ai" ? "bg-violet-200 dark:bg-violet-900" : "bg-amber-200 text-amber-950")}>
          {report.mode === "ai" ? "AI" : FALLBACK}
        </span>
      </div>
      {transcript && (
        <div>
          <div className="font-semibold">Transcript</div>
          <p className="whitespace-pre-wrap italic">“{transcript}”</p>
        </div>
      )}
      {report.transcriptError && <p className="text-amber-900 dark:text-amber-200">{report.transcriptError}</p>}
      {report.summary && <p>{report.summary}</p>}
      <List title="Work done" items={report.workDone} />
      <List title="Materials used" items={report.materialsUsed.map(qty)} />
      <List title="Materials needed" items={report.materialsNeeded.map(qty)} />
      <List title="Blockers" items={report.blockers} />
      <List title="Safety issues" items={report.safetyIssues} />
      {report.createdTasks.length > 0 && (
        <div>
          <div className="font-semibold">Created by report agent</div>
          <ul className="space-y-0.5">
            {report.createdTasks.map((t) => (
              <li key={t.id}>
                <Link href={taskHref(t.id)} className="underline underline-offset-2" data-testid="agent-task-link">
                  {t.title}
                </Link>
                {t.priority === "urgent" && <span className="ml-1 rounded bg-red-200 px-1 text-xs font-semibold text-red-900">urgent</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
