// Media upload queue. Voice notes and photos are stored as Blobs in Dexie
// (`media`) while offline; `note.created` references the local media id.
// When online, each blob is uploaded (POST /api/media -> private Vercel Blob);
// the SERVER records `note.media_uploaded` with the pathname it chose, so the
// device never reports a URL. The next pull brings `mediaUrl` (an
// authenticated route). The local blob is kept so this device can play its own
// media offline. Retries use the outbox backoff. Single-flight + a Web Lock.
import { getMeta, localDb, type MediaItem } from "../db/local";
import type { NoteKind } from "../domain";
import { uuidv4 } from "../uuid";
import { backoffMs, enqueue, sync } from "./client";

export type UploadInput = {
  file: Blob;
  mediaId: string;
  noteId: string;
  actorId: string;
  mimeType: string;
  durationSec: number | null;
};
export type UploadTransport = (input: UploadInput) => Promise<{ ok: true; mediaUrl: string | null }>;

const UPLOAD_TIMEOUT_MS = 90_000;

const httpUpload: UploadTransport = async ({ file, mediaId, noteId, actorId, mimeType, durationSec }) => {
  const form = new FormData();
  form.append("file", new Blob([file], { type: mimeType }), mediaId);
  form.append("mediaId", mediaId);
  form.append("noteId", noteId);
  form.append("actorId", actorId);
  if (durationSec !== null) form.append("durationSec", String(durationSec));
  const res = await fetch("/api/media", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    cache: "no-store",
  });
  if (res.status === 401) throw new Error("Access code needed: reload the app and enter it");
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return (await res.json()) as { ok: true; mediaUrl: string | null };
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
    if (note.mediaUrl) {
      await localDb.media.update(m.id, { status: "uploaded" }); // another tab/run already did it
      continue;
    }
    try {
      // The server stores the blob AND records note.media_uploaded. A retry after
      // a lost response overwrites the same path and is a duplicate event.
      await transport({ file: m.blob, mediaId: m.id, noteId: m.noteId, actorId, mimeType: m.mimeType, durationSec: m.durationSec });
      await localDb.media.update(m.id, { status: "uploaded", lastError: null });
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
  // Pull the note rows that now carry mediaUrl.
  if (summary.uploaded > 0) void sync().catch(() => {});
  return summary;
}
