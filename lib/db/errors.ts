// Telling "the database connection failed" apart from "the query was wrong".
// Neon over WebSocket fails in several shapes: Drizzle wraps the driver error
// ("Failed query: ..."), the cause may be a Node net error (ETIMEDOUT), an
// AggregateError of per-address connect errors (IPv4 timeout + IPv6
// ENETUNREACH), a ws ErrorEvent (serialises as {}), or a Postgres
// "connection terminated / admin shutdown" error. Only these are retried.

const NET_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);
/** Postgres SQLSTATEs for lost connections and server shutdown / restart. */
const PG_CODES = new Set(["08000", "08001", "08003", "08004", "08006", "57P01", "57P02", "57P03", "53300"]);
const MESSAGE =
  /connection terminated|connection (was )?closed|terminating connection|socket hang up|websocket|timed? ?out|fetch failed|server closed the connection|too many connections|connection reset|network/i;

type Errish = { message?: unknown; code?: unknown; cause?: unknown; errors?: unknown; error?: unknown; type?: unknown; constructor?: { name?: string } };

function children(e: Errish): unknown[] {
  const out: unknown[] = [];
  if (e.cause !== undefined) out.push(e.cause);
  if (Array.isArray(e.errors)) out.push(...e.errors);
  if (e.error !== undefined && e.error !== e) out.push(e.error); // ws ErrorEvent.error
  return out;
}

export function isTransientDbError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== "object" || depth > 6) return false;
  const e = err as Errish;
  const code = typeof e.code === "string" ? e.code : "";
  if (NET_CODES.has(code) || PG_CODES.has(code)) return true;
  // A ws ErrorEvent / CloseEvent from the Neon WebSocket.
  const name = e.constructor?.name ?? "";
  if (name === "ErrorEvent" || name === "CloseEvent" || (e.type === "error" && !("message" in e && e.message))) return true;
  if (name === "AggregateError" && Array.isArray(e.errors) && e.errors.some((x) => isTransientDbError(x, depth + 1))) return true;
  // Drizzle's wrapper carries the SQL in its message; judge it by its cause only.
  const msg = typeof e.message === "string" ? e.message : "";
  if (msg && !msg.startsWith("Failed query") && MESSAGE.test(msg)) return true;
  return children(e).some((c) => isTransientDbError(c, depth + 1));
}

/** Everything useful about an error, cause chain and aggregated errors included (for logs). */
export function describeError(err: unknown, depth = 0): string {
  const pad = "  ".repeat(depth);
  if (depth > 6) return `${pad}…`;
  if (!err || typeof err !== "object") return `${pad}${String(err)}`;
  const e = err as Errish & { stack?: string; address?: unknown; port?: unknown; syscall?: unknown };
  const name = e.constructor?.name ?? "Object";
  const bits = [
    typeof e.message === "string" && e.message ? e.message.slice(0, 2000) : "(no message)",
    e.code ? `code=${String(e.code)}` : "",
    e.syscall ? `syscall=${String(e.syscall)}` : "",
    e.address ? `address=${String(e.address)}${e.port ? `:${String(e.port)}` : ""}` : "",
    e.type && name.endsWith("Event") ? `type=${String(e.type)}` : "",
  ].filter(Boolean);
  const lines = [`${pad}${name}: ${bits.join(" ")}`];
  if (depth === 0 && e.stack) lines.push(e.stack.split("\n").slice(1, 6).map((l) => `${pad}${l.trim()}`).join("\n"));
  for (const c of children(e)) lines.push(`${pad}caused by:\n${describeError(c, depth + 1)}`);
  return lines.join("\n");
}

/**
 * Run `fn`; if it fails with a transient DB error, wait and run it once more
 * (default). `fn` must be safe to repeat: a whole transaction that rolled
 * back, or idempotent work (events are deduplicated by id).
 */
export async function withTransientRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { retries?: number; delayMs?: number; onRetry?: (err: unknown, attempt: number) => void } = {},
): Promise<T> {
  const retries = opts.retries ?? 1;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries || !isTransientDbError(err)) throw err;
      opts.onRetry?.(err, attempt);
      await new Promise((r) => setTimeout(r, (opts.delayMs ?? 300) * (attempt + 1)));
    }
  }
}
