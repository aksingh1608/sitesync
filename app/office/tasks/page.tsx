"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { UpdatedAgo, useSnapshot } from "@/components/office/data";
import { TaskTable } from "@/components/office/tasks";
import { PageHeader } from "@/components/office/ui";
import { TASK_VIEWS, type TaskView } from "@/lib/office/derive";

export default function TasksPage() {
  const { error, updatedAt } = useSnapshot();
  return (
    <>
      <PageHeader title="Tasks">
        <UpdatedAgo at={updatedAt} error={error} />
      </PageHeader>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <WithView />
      </Suspense>
    </>
  );
}

function WithView() {
  const params = useSearchParams();
  const router = useRouter();
  const v = params.get("view");
  const view = TASK_VIEWS.includes(v as TaskView) ? (v as TaskView) : null;
  const task = params.get("task");
  const uuid = (v: string | null) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : null);
  const site = uuid(params.get("site"));
  const assignee = uuid(params.get("assignee"));
  return (
    <TaskTable
      key={`${site}|${assignee}|${task}`}
      view={view}
      onClearView={() => router.replace("/office/tasks")}
      initialTaskId={uuid(task)}
      initialFilters={site || assignee ? { ...(site ? { site } : {}), ...(assignee ? { assignee } : {}) } : undefined}
    />
  );
}
