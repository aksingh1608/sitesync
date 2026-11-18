"use client";
// Replaces the root layout when it fails; must render its own document.
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 480, margin: "0 auto" }}>
        <title>SiteSync</title>
        <h1 style={{ fontSize: 20 }}>SiteSync could not start this screen</h1>
        <p>Changes saved on this device are kept and will sync later. Try again, or reload the app.</p>
        {error.digest && <p style={{ fontSize: 12, color: "#64748b" }}>Error reference: {error.digest}</p>}
        <button onClick={() => retry()} style={{ padding: "8px 16px", fontWeight: 600 }}>
          Try again
        </button>
      </body>
    </html>
  );
}
