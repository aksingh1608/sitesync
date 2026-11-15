export const metadata = { title: "Offline" };

export default function OfflinePage() {
  return (
    <main className="mx-auto max-w-md p-6 space-y-3">
      <h1 className="text-xl font-semibold">You are offline</h1>
      <p className="text-sm text-muted-foreground">
        This page has not been saved on this device yet. Your tasks and anything you recorded are safe
        on this device.
      </p>
      <p className="text-sm">
        <a className="underline" href="/field">
          Open my tasks
        </a>
      </p>
    </main>
  );
}
