// Media upload queue. Voice notes and photos are stored as Blobs in Dexie
// (`media`) while offline; `note.created` references the local media id.
// When online, each blob is uploaded (POST /api/media -> Vercel Blob), then
// `note.media_uploaded` is queued like any other event. Retries use the same
// backoff as the outbox. Single-flight in-tab + a Web Lock across tabs.
import { getMeta, localDb, type MediaItem } from "../db/local";
import type { NoteKind } from "../domain";
import { uuidv4 } from "../uuid";
import { backoffMs, enqueue, sync } from "./client";

export type UploadInput = { file: Blob; mediaId: string; noteId: string; actorId: string; mimeType: string };
export type UploadTransport = (input: UploadInput) => Promise<{ url: string }>;

const UPLOAD_TIMEOUT_MS = 90_000;

const httpUpload: UploadTransport = async ({ file, mediaId, noteId, actorId, mimeType }) => {
  const form = new FormData();
  form.append("file", new Blob([file], { type: mimeType }), mediaId);
  form.append("mediaId", mediaId);
  form.append("noteId", noteId);
  form.append("actorId", actorId);
  const res = await fetch("/api/media", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return (await res.json()) as { url: string };
};

let transport: UploadTransport = httpUpload;
export function setUploadTransport(t: UploadTransport | null) {
  transport = t ?? httpUpload;
}

/** Save a note (text, voice or photo). Blob + event are written in one transaction. */
export async function saveNote(input: {
  kind: NoteKind;
  siteId: string;
  taskId?: string | null;
  text?: string | null;
  media?: { blob: Blob; mimeType: string; durationSec?: number | null };
}): Promise<string> {
  const noteId = uuidv4();
  const mediaId = input.media ? uuidv4() : null;
  const media: Omit<MediaItem, "actorId"> | undefined =
    input.media && mediaId
      ? {
          id: mediaId,
          noteId,
          kind: input.kind === "voice" ? "voice" : "photo",
          blob: input.media.blob,
          mimeType: input.media.mimeType,
          sizeBytes: input.media.blob.size,
          durationSec: input.media.durationSec ?? null,
          status: "pending",
          attempts: 0,
          lastError: null,
          nextAttemptAt: null,
          blobUrl: null,
          createdAt: new Date(),
        }
      : undefined;
  await enqueue(
    {
      type: "note.created",
      payload: {
        noteId,
        siteId: input.siteId,
        taskId: input.taskId ?? null,
        kind: input.kind,
        text: input.text?.trim() ? input.text.trim() : null,
        mediaId,
      },
    },
    { media },
  );
  return noteId;
}

export type UploadSummary = { uploaded: number; failed: number; waiting: number; skipped?: string };

let inflight: Promise<UploadSummary> | null = null;

export function uploadPending(): Promise<UploadSummary> {
  if (inflight) return inflight;
  const run = async () => {
    if (typeof navigator !== "undefined" && navigator.locks) {
      return navigator.locks.request("sitesync-upload", { ifAvailable: true }, async (lock) =>
        lock ? runUploads() : { uploaded: 0, failed: 0, waiting: 0, skipped: "another tab is uploading" },
      );
    }
    return runUploads();
  };
  inflight = run().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function runUploads(): Promise<UploadSummary> {
  const meta = await getMeta();
  const summary: UploadSummary = { uploaded: 0, failed: 0, waiting: 0 };
  if (!meta.actorId) return { ...summary, skipped: "no actor" };
  if (meta.simulateOffline) return { ...summary, skipped: "offline (simulated)" };
  const actorId = meta.actorId;

  // Free space: once the server copy of the note has its URL, drop the local blob.
  const done = await localDb.media.where("[actorId+status]").equals([actorId, "uploaded"]).toArray();
  for (const m of done) {
    if (!m.blob) continue;
    const note = await localDb.fieldNotes.get(m.noteId);
    if (note?.seq !== undefined && note.blobUrl) await localDb.media.update(m.id, { blob: null });
  }

  const pending = (await localDb.media.where("[actorId+status]").equals([actorId, "pending"]).toArray()).sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  for (const m of pending) {
    const note = await localDb.fieldNotes.get(m.noteId);
    // The server must have the note first (the route checks it belongs to you).
    if (!note || note.seq === undefined || !m.blob || (m.nextAttemptAt && m.nextAttemptAt.getTime() > Date.now())) {
      summary.waiting++;
      continue;
    }
    if (note.blobUrl) {
      await localDb.media.update(m.id, { status: "uploaded", blobUrl: note.blobUrl });
      continue;
    }
    try {
      const { url } = await transport({ file: m.blob, mediaId: m.id, noteId: m.noteId, actorId, mimeType: m.mimeType });
      // If we crash between these two writes the blob is uploaded again to the
      // same path, and the second event is a no-op on the server (first URL wins).
      await enqueue(
        {
          type: "note.media_uploaded",
          payload: {
            noteId: m.noteId,
            blobUrl: url,
            mimeType: m.mimeType,
            sizeBytes: m.sizeBytes,
            ...(m.durationSec !== null ? { durationSec: m.durationSec } : {}),
          },
        },
        { autoSync: false },
      );
      await localDb.media.update(m.id, { status: "uploaded", blobUrl: url, lastError: null });
      summary.uploaded++;
    } catch (err) {
      const attempts = m.attempts + 1;
      await localDb.media.update(m.id, {
        attempts,
        lastError: err instanceof Error ? err.message : String(err),
        nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
      });
      summary.failed++;
    }
  }
  if (summary.uploaded > 0) void sync().catch(() => {});
  return summary;
}
