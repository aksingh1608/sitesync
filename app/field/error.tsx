"use client";
// Inside the field layout, so the sync bar and bottom nav stay visible.
import { ErrorScreen } from "@/components/error-screen";

export default function FieldError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorScreen error={error} retry={retry} home="/field" homeLabel="My tasks" large />;
}
