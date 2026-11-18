// POST /api/media: upload a note's voice/photo blob to the PRIVATE Blob store
// (server upload: Vercel caps the body at 4.5 MB, our cap is 4 MB). The server
// derives the pathname, stores the blob, then records `note.media_uploaded`
// itself through processSync. The device never reports a URL or a path.
import { after, NextResponse } from "next/server";
import { z } from "zod";
import { MAX_MEDIA_BYTES, MAX_VOICE_SECONDS } from "@/lib/domain";
import { mediaPathFor } from "@/lib/events";
import { afterSyncAgents } from "@/lib/agents/hooks";
import { withDb } from "@/lib/db/server";
import { checkUploadAllowed, recordMediaUpload } from "@/lib/media/record";
import { storeMedia } from "@/lib/media/store";
import { baseMime, extFor } from "@/lib/media/types";
import { mediaUrlFor } from "@/lib/sync/visibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const noStore = { "cache-control": "no-store" };
const Fields = z.object({
  mediaId: z.uuid(),
  noteId: z.uuid(),
  actorId: z.uuid(),
  durationSec: z.coerce.number().nonnegative().max(MAX_VOICE_SECONDS + 5).optional(),
});

const fail = (status: number, error: string) => NextResponse.json({ error }, { status, headers: noStore });

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, "invalid_form");
  }
  const raw = Object.fromEntries(
    ["mediaId", "noteId", "actorId", "durationSec"].flatMap((k) => (form.get(k) === null ? [] : [[k, form.get(k)]])),
  );
  const fields = Fields.safeParse(raw);
  const file = form.get("file");
  if (!fields.success || !(file instanceof Blob)) return fail(400, "invalid_request");
  const { mediaId, noteId, actorId, durationSec } = fields.data;
  const mime = baseMime(file.type || "");
  const ext = extFor(mime);
  if (!ext) return fail(415, `unsupported_type: ${mime || "unknown"}`);
  if (file.size === 0 || file.size > MAX_MEDIA_BYTES) return fail(413, "too_large");

  try {
    const allowed = await withDb((db) => checkUploadAllowed(db, { actorId, noteId, mediaId }));
    if (!allowed.ok) return fail(allowed.status, allowed.error);

    const blobPath = await storeMedia({ pathname: mediaPathFor(noteId, mediaId, ext), file, contentType: mime });
    const recorded = await withDb((db) =>
      recordMediaUpload(db, { actorId, noteId, mediaId, blobPath, mimeType: mime, sizeBytes: file.size, durationSec }),
    );
    if (!recorded.ok) return fail(409, recorded.error);
    // Voice notes: transcribe + report after the response (the phone never waits for AI).
    after(() => afterSyncAgents(withDb, { trigger: "upload", noteId, throttleEscalations: false }));
    return NextResponse.json({ ok: true, mediaUrl: mediaUrlFor(noteId, blobPath) }, { headers: noStore });
  } catch (err) {
    if (err instanceof Error && err.message === "blob_not_configured") return fail(503, "blob_not_configured");
    console.error("[api/media] failed", err);
    return fail(500, "internal_error");
  }
}
