// GET /api/media/<noteId>: the only way a client reads a note's media. Checks
// the (demo) actor may see the note, then streams the PRIVATE blob with the
// server's credentials. Supports If-None-Match (304) and byte ranges (iOS
// Safari requests audio with Range and needs 206 responses).
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { fieldNotes, people } from "@/lib/db/schema";
import { withDb } from "@/lib/db/server";
import { canViewNote } from "@/lib/media/record";
import { readMedia } from "@/lib/media/store";
import { ACTOR_COOKIE } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const base = { "x-content-type-options": "nosniff", "cache-control": "private, no-cache" };
const text = (status: number, body: string) => new Response(body, { status, headers: { "cache-control": "no-store" } });

async function toBytes(body: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export async function GET(request: NextRequest, ctx: RouteContext<"/api/media/[noteId]">) {
  const { noteId } = await ctx.params;
  const actorId = request.cookies.get(ACTOR_COOKIE)?.value ?? "";
  if (!UUID.test(noteId)) return text(404, "not found");
  if (!UUID.test(actorId)) return text(401, "pick a person first");

  try {
    const found = await withDb(async (db) => {
      const [[actor], [note]] = await Promise.all([
        db.select().from(people).where(eq(people.id, actorId)),
        db.select().from(fieldNotes).where(eq(fieldNotes.id, noteId)),
      ]);
      return { actor, note };
    });
    if (!found.actor) return text(401, "unknown actor");
    // Same answer for "missing" and "not yours", so ids can't be probed.
    if (!found.note?.blobPath || !canViewNote(found.actor, found.note)) return text(404, "not found");

    const media = await readMedia(
      found.note.blobPath,
      found.note.mimeType ?? "application/octet-stream",
      request.headers.get("if-none-match") ?? undefined,
    );
    if (!media) return text(404, "not found");
    if (media.status === 304) return new Response(null, { status: 304, headers: { ...base, etag: media.etag } });

    const headers = { ...base, etag: media.etag, "content-type": media.contentType, "accept-ranges": "bytes" };
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
    if (!range) {
      return new Response(media.body as BodyInit, { headers: { ...headers, "content-length": String(media.size) } });
    }
    // Media is at most 4 MB, so buffering for a range response is fine.
    const bytes = await toBytes(media.body);
    const size = bytes.byteLength;
    let start = range[1] === "" ? size - Number(range[2]) : Number(range[1]);
    let end = range[1] === "" || range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
    if (range[1] === "" && range[2] === "") [start, end] = [0, size - 1];
    if (!(start >= 0 && start <= end && end < size)) {
      return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
    }
    return new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
    });
  } catch (err) {
    console.error("[api/media/:noteId] failed", err);
    return text(500, "internal_error");
  }
}
