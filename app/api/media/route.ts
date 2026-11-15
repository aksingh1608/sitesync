// POST /api/media: upload a note's voice/photo blob. Server upload (the body
// passes through this function; Vercel caps it at 4.5 MB, our cap is 4 MB).
// The route only reads the database; the URL is recorded by the client's
// `note.media_uploaded` event, like every other write.
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { MAX_MEDIA_BYTES } from "@/lib/domain";
import { fieldNotes, people } from "@/lib/db/schema";
import { withDb } from "@/lib/db/server";
import { storeMedia } from "@/lib/media/store";
import { baseMime, extFor } from "@/lib/media/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const noStore = { "cache-control": "no-store" };
const Fields = z.object({ mediaId: z.uuid(), noteId: z.uuid(), actorId: z.uuid() });

const fail = (status: number, error: string) => NextResponse.json({ error }, { status, headers: noStore });

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, "invalid_form");
  }
  const fields = Fields.safeParse(Object.fromEntries(["mediaId", "noteId", "actorId"].map((k) => [k, form.get(k)])));
  const file = form.get("file");
  if (!fields.success || !(file instanceof Blob)) return fail(400, "invalid_request");
  const { mediaId, noteId, actorId } = fields.data;
  const mime = baseMime(file.type || "");
  const ext = extFor(mime);
  if (!ext) return fail(415, `unsupported_type: ${mime || "unknown"}`);
  if (file.size === 0 || file.size > MAX_MEDIA_BYTES) return fail(413, "too_large");

  try {
    const allowed = await withDb(async (db) => {
      const [actor] = await db.select().from(people).where(eq(people.id, actorId));
      if (!actor?.active) return "unknown_actor";
      const [note] = await db
        .select({ id: fieldNotes.id })
        .from(fieldNotes)
        .where(and(eq(fieldNotes.id, noteId), eq(fieldNotes.personId, actorId), eq(fieldNotes.mediaId, mediaId)));
      return note ? null : "note_not_found";
    });
    if (allowed) return fail(allowed === "unknown_actor" ? 403 : 404, allowed);

    const url = await storeMedia({
      pathname: `notes/${noteId}/${mediaId}.${ext}`,
      file,
      contentType: mime,
      origin: new URL(request.url).origin,
    });
    return NextResponse.json({ url }, { headers: noStore });
  } catch (err) {
    if (err instanceof Error && err.message === "blob_not_configured") return fail(503, "blob_not_configured");
    console.error("[api/media] failed", err);
    return fail(500, "internal_error");
  }
}
