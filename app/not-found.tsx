import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-md space-y-3 p-6 text-sm">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p>This link does not lead anywhere in SiteSync.</p>
      <div className="flex gap-3">
        <Link href="/field" className="underline">Field app</Link>
        <Link href="/office" className="underline">Office dashboard</Link>
      </div>
    </main>
  );
}
