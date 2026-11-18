// POST { digestId }: push the digest to every active manager ("Send to
// manager"). A notification, not an escalation: the agent itself never sends.
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { loadDigest, managerIds, type DigestContent } from "@/lib/agents/digest";
import { digests } from "@/lib/db/schema";
import { canManageTasks } from "@/lib/domain";
import { officePost } from "@/lib/office/route";
import { pushToPeople } from "@/lib/push/send";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.strictObject({ digestId: z.uuid() });

export function POST(request: NextRequest) {
  return officePost(request, canManageTasks, async (db, _actor, body) => {
    const parsed = Body.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    const digest = await loadDigest(db, parsed.data.digestId);
    if (!digest) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const managers = await managerIds(db);
    const first = digest.content.narrative.highlights[0] ?? digest.summary;
    const r = await pushToPeople(db, managers, {
      title: `Daily digest, ${digest.day}`,
      body: first.slice(0, 180),
      url: `/office/digest?day=${digest.day}`,
      tag: `digest-${digest.day}`,
    });
    const content: DigestContent = {
      ...digest.content,
      sentTo: [...(digest.content.sentTo ?? []), { at: new Date().toISOString(), people: managers.length, delivered: r.delivered }],
    };
    await db.update(digests).set({ content }).where(eq(digests.id, digest.id));
    return { managers: managers.length, subscriptions: r.subscriptions, delivered: r.delivered, errors: r.errors };
  });
}
