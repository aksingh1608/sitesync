// Server side of a media upload, kept out of the route so it can be tested on
// PGlite: (1) may this actor upload media for this note? (2) after the blob is
// stored, record it through the normal event path (processSync, trusted).
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { isOfficeRole, type Role } from "../domain";
import { fieldNotes, people, type FieldNote } from "../db/schema";
import { processSync } from "../sync/service";
import type { Db } from "../sync/store-drizzle";

export const SERVER_DEVICE_ID = "server:media";

/** A stable UUID v4 per media id, so a retried upload is a duplicate event, not a second one. */
export function mediaEventId(mediaId: string): string {
  const h = createHash("sha256").update(`note.media_uploaded:${mediaId}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type UploadCheck = { ok: true } | { ok: false; status: 403 | 404; error: string };

export async function checkUploadAllowed(
  db: Db,
  input: { actorId: string; noteId: string; mediaId: string },
): Promise<UploadCheck> {
  const [actor] = await db.select().from(people).where(eq(people.id, input.actorId));
  if (!actor?.active) return { ok: false, status: 403, error: "unknown_actor" };
  const [note] = await db
    .select({ id: fieldNotes.id })
    .from(fieldNotes)
    .where(
      and(eq(fieldNotes.id, input.noteId), eq(fieldNotes.personId, input.actorId), eq(fieldNotes.mediaId, input.mediaId)),
    );
  return note ? { ok: true } : { ok: false, status: 404, error: "note_not_found" };
}

export async function recordMediaUpload(
  db: Db,
  input: {
    actorId: string;
    noteId: string;
    mediaId: string;
    blobPath: string;
    mimeType: string;
    sizeBytes: number;
    durationSec?: number;
  },
  now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  const out = await processSync(
    db,
    {
      deviceId: SERVER_DEVICE_ID,
      actorId: input.actorId,
      cursor: null,
      events: [
        {
          id: mediaEventId(input.mediaId),
          type: "note.media_uploaded",
          actorId: input.actorId,
          deviceId: SERVER_DEVICE_ID,
          clientTs: now.toISOString(),
          payload: {
            noteId: input.noteId,
            blobPath: input.blobPath,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            ...(input.durationSec !== undefined ? { durationSec: input.durationSec } : {}),
          },
        },
      ],
    },
    { trusted: true, skipPull: true, now: () => now },
  );
  if (!out.ok) return { ok: false, error: out.error };
  const rejected = out.response.rejected[0];
  return rejected ? { ok: false, error: rejected.reason } : { ok: true };
}

/** Who may play a note's media. Mirrors pull visibility: the author, or office roles. */
export function canViewNote(actor: { id: string; role: Role; active: boolean }, note: Pick<FieldNote, "personId">) {
  return actor.active && (note.personId === actor.id || isOfficeRole(actor.role));
}
