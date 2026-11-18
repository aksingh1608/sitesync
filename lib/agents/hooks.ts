// When agents run automatically. Always after the response (`after()` in the
// route), never inside a sync: an agent failure or a slow model can never
// block or fail a phone's sync.
import { runEscalationsSafe, type RunDeps } from "../escalation/run";
import type { Db } from "../sync/store-drizzle";
import { processPendingReports, runReportAgent, type ReportDeps } from "./report";

type Open = <T>(fn: (db: Db) => Promise<T>) => Promise<T>;

/**
 * Report agent for waiting notes, then the escalation rules. If the agent
 * created tasks (e.g. an urgent safety task) the rules run right away instead
 * of throttled, so the coordinator is notified within seconds.
 */
export async function afterSyncAgents(
  open: Open,
  opts: { trigger: "sync" | "upload" | "poll"; noteId?: string; throttleEscalations: boolean; deps?: ReportDeps; escalationDeps?: RunDeps },
): Promise<void> {
  let created = 0;
  try {
    await open(async (db) => {
      const runs = opts.noteId
        ? [await runReportAgent(db, opts.noteId, { trigger: opts.trigger, deps: opts.deps })]
        : await processPendingReports(db, { trigger: opts.trigger, limit: opts.trigger === "poll" ? 1 : 3, deps: opts.deps });
      for (const r of runs) if (r.status !== "skipped") created += r.created.length;
    });
  } catch (err) {
    console.error(`[agents] after-${opts.trigger} report run failed:`, err);
  }
  await runEscalationsSafe(open, { trigger: opts.trigger === "upload" ? "sync" : opts.trigger, throttle: opts.throttleEscalations && created === 0, deps: opts.escalationDeps });
}
