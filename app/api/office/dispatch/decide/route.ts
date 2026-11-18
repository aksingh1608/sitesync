// POST { draftId, decision: "approve", edits? } | { draftId, decision: "reject", reason }.
// Approve creates the task through POST-equivalent processSync as the
// coordinator (source dispatch_agent); reject stores the reason.
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ApproveEditsSchema, approveDraft, rejectDraft } from "@/lib/agents/dispatch";
import { canManageTasks } from "@/lib/domain";
import { officePost } from "@/lib/office/route";
import { processSync } from "@/lib/sync/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("decision", [
  z.strictObject({
    draftId: z.uuid(),
    decision: z.literal("approve"),
    edits: ApproveEditsSchema.default({}),
    deviceId: z.string().min(1).max(100).default("office:dispatch"),
  }),
  z.strictObject({ draftId: z.uuid(), decision: z.literal("reject"), reason: z.string().trim().min(3).max(500) }),
]);

export function POST(request: NextRequest) {
  return officePost(request, canManageTasks, async (db, actor, body) => {
    const parsed = Body.safeParse(body);
    if (!parsed.success) {
      const rejecting = (body as { decision?: string } | null)?.decision === "reject";
      return NextResponse.json({ error: rejecting ? "A short reason is required to reject." : "invalid_request" }, { status: 400 });
    }
    const b = parsed.data;
    const out =
      b.decision === "reject"
        ? await rejectDraft(db, { draftId: b.draftId, actorId: actor.id, reason: b.reason })
        : await approveDraft(
            db,
            { draftId: b.draftId, actorId: actor.id, edits: b.edits, deviceId: b.deviceId },
            {
              process: async (req) => {
                const r = await processSync(db, { ...req, cursor: null, pull: false }, { skipPull: true });
                return r.ok ? r.response : { error: r.error };
              },
            },
          );
    return out.ok ? out : NextResponse.json({ error: out.error }, { status: out.status });
  });
}
