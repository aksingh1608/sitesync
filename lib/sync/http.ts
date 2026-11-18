// POST /api/sync request handling, separate from the route so it is testable
// with any database runner.
import { describeError, isTransientDbError, withTransientRetry } from "../db/errors";
import { SyncRequestSchema, type SyncRequest } from "./protocol";
import type { SyncOutcome } from "./service";

const noStore = { "cache-control": "no-store" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...noStore, ...headers } });

/** Seconds a client should wait after a 503 (it also has its own backoff). */
export const RETRY_AFTER_S = 5;

/**
 * Validates the body, runs the sync. A transient database failure (Neon
 * timeout, dropped WebSocket) is retried once: the transaction rolled back and
 * events are idempotent by id, so repeating is safe. If it fails again the
 * client gets 503 { retryable: true } and keeps the events in its outbox.
 */
export async function handleSync(
  body: unknown,
  run: (req: SyncRequest) => Promise<SyncOutcome>,
  opts: { retryDelayMs?: number } = {},
): Promise<Response> {
  const parsed = SyncRequestSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_request", issues: parsed.error.issues.slice(0, 10) }, 400);
  try {
    const outcome = await withTransientRetry(() => run(parsed.data), {
      retries: 1,
      delayMs: opts.retryDelayMs,
      onRetry: (err) => console.warn("[api/sync] transient database error, retrying once:\n" + describeError(err)),
    });
    if (!outcome.ok) {
      if (outcome.status === 429) {
        // Not an error the client should surface: it keeps the events and backs off.
        return json({ error: outcome.error, retryable: true }, 429, { "retry-after": String(outcome.retryAfterSec) });
      }
      return json({ error: outcome.error }, outcome.status);
    }
    return json(outcome.response);
  } catch (err) {
    if (isTransientDbError(err)) {
      console.error("[api/sync] database unavailable after retry:\n" + describeError(err));
      return json({ error: "db_unavailable", retryable: true }, 503, { "retry-after": String(RETRY_AFTER_S) });
    }
    console.error("[api/sync] failed:\n" + describeError(err));
    return json({ error: "internal_error", retryable: false }, 500);
  }
}
