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
  return <TaskTable view={view} onClearView={() => router.replace("/office/tasks")} />;
}
