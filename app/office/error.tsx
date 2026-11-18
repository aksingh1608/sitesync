"use client";
import { ErrorScreen } from "@/components/error-screen";

export default function OfficeError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorScreen error={error} retry={retry} home="/office" homeLabel="Live board" />;
}
