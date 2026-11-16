// Media upload queue end to end: Dexie (fake-indexeddb) + processSync (PGlite)
// with a stub upload transport in place of /api/media.
import "fake-indexeddb/auto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { events, fieldNotes } from "@/lib/db/schema";
import { localDb, setMeta } from "@/lib/db/local";
import { setActor, setAfterSync, setTransport, sync } from "@/lib/sync/client";
import { saveNote, setUploadTransport, uploadPending, type UploadInput } from "@/lib/sync/media";
import { mediaPathFor } from "@/lib/events";
import { checkUploadAllowed, recordMediaUpload } from "@/lib/media/record";
import { processSync } from "@/lib/sync/service";
import type { Db } from "@/lib/sync/store-drizzle";
import type { WireSyncResponse } from "@/lib/sync/protocol";
import { at, ids, makeDb, taskCreated, uuid } from "./helpers";

let db: Db;
let close: () => Promise<void>;
let uploads: UploadInput[] = [];
let uploadFails = 0;
let loseResponse = 0;

beforeEach(async () => {
  ({ db, close } = await makeDb());
  uploads = [];
  uploadFails = 0;
  loseResponse = 0;
  setTransport(async (req) => {
    const out = await processSync(db, JSON.parse(JSON.stringify(req)));
    if (!out.ok) throw new Error(out.error);
    return JSON.parse(JSON.stringify(out.response)) as WireSyncResponse;
  });
  // Stand-in for POST /api/media: the same server functions, storage skipped.
  setUploadTransport(async (input) => {
    uploads.push(input);
    if (uploadFails-- > 0) throw new Error("upload failed");
    const check = await checkUploadAllowed(db, input);
    if (!check.ok) throw new Error(check.error);
    const blobPath = mediaPathFor(input.noteId, input.mediaId, "m4a");
    const r = await recordMediaUpload(db, {
      ...input,
      blobPath,
      sizeBytes: input.file.size,
      durationSec: input.durationSec ?? undefined,
    });
    if (!r.ok) throw new Error(r.error);
    if (loseResponse-- > 0) throw new Error("response lost"); // stored + recorded, but the device never heard
    return { ok: true, mediaUrl: `/api/media/${input.noteId}` };
  });
  setAfterSync(null);
  await localDb.delete({ disableAutoOpen: false });
  const r = await processSync(db, {
    deviceId: "office",
    actorId: ids.coordinator,
    cursor: null,
    events: [taskCreated(ids.coordinator, uuid(), at("2026-11-15T09:00:00Z"))],
  });
  if (!r.ok) throw new Error(r.error);
});
afterEach(async () => {
  setTransport(null);
  setUploadTransport(null);
  await close();
});

describe("media upload queue", () => {
  it("keeps a voice note offline, uploads it once online, and stores every event once", async () => {
    await setActor(ids.techA);
    await sync();
    await setMeta({ simulateOffline: true });

    const audio = new Blob([new Uint8Array(2048)], { type: "audio/mp4" });
    const noteId = await saveNote({ kind: "voice", siteId: ids.siteA, media: { blob: audio, mimeType: "audio/mp4", durationSec: 4.2 } });
    expect(await localDb.outbox.count()).toBe(1);
    const [m] = await localDb.media.toArray();
    expect(m).toMatchObject({ noteId, status: "pending", sizeBytes: 2048 });
    expect((await localDb.fieldNotes.get(noteId))?.mediaId).toBe(m.id); // optimistic note

    // Offline: nothing is uploaded.
    expect((await uploadPending()).skipped).toMatch(/offline/);
    expect(uploads).toHaveLength(0);

    await setMeta({ simulateOffline: false });
    // Before the note reaches the server, the upload waits.
    expect(await uploadPending()).toMatchObject({ uploaded: 0, waiting: 1 });
    await sync({ manual: true });

    // First upload attempt fails -> backoff; a second pass before the retry time waits.
    uploadFails = 1;
    expect(await uploadPending()).toMatchObject({ failed: 1 });
    const failed = await localDb.media.get(m.id);
    expect(failed).toMatchObject({ attempts: 1, lastError: "upload failed", status: "pending" });
    expect(failed!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await uploadPending()).toMatchObject({ waiting: 1 });

    // Next attempt: the server stores + records it, but the response is lost.
    await localDb.media.update(m.id, { nextAttemptAt: new Date(0) }); // time passes
    loseResponse = 1;
    expect(await uploadPending()).toMatchObject({ failed: 1 });
    // The retry is a duplicate on the server, not a second event.
    await localDb.media.update(m.id, { nextAttemptAt: new Date(0) });
    expect(await uploadPending()).toMatchObject({ uploaded: 1 });
    await sync({ manual: true });

    const [server] = await db.select().from(fieldNotes).where(eq(fieldNotes.id, noteId));
    expect(server.blobPath).toBe(`notes/${noteId}/${m.id}.m4a`);
    expect(server).toMatchObject({ mimeType: "audio/mp4", sizeBytes: 2048, durationSec: 4.2, kind: "voice" });
    // The device gets the authenticated route, never the pathname or a blob URL.
    const local = await localDb.fieldNotes.get(noteId);
    expect(local?.mediaUrl).toBe(`/api/media/${noteId}`);
    expect(local?.blobPath).toBeNull();
    expect(await localDb.outbox.count()).toBe(0);

    const types = (await db.select({ type: events.type }).from(events).where(eq(events.actorId, ids.techA))).map((e) => e.type);
    expect(types.filter((t) => t === "note.created")).toHaveLength(1);
    expect(types.filter((t) => t === "note.media_uploaded")).toHaveLength(1);
    expect(uploads).toHaveLength(3);

    // The recording device keeps its own copy for offline playback; nothing re-uploads.
    await uploadPending();
    const kept = await localDb.media.get(m.id);
    expect(kept?.status).toBe("uploaded");
    expect(kept?.blob?.size).toBe(2048);
    expect(uploads).toHaveLength(3);
    const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(events);
    expect(Number(n)).toBeGreaterThan(0);
  });

  it("saves a text note with no media", async () => {
    await setActor(ids.techA);
    await sync();
    const noteId = await saveNote({ kind: "text", siteId: ids.siteA, text: "  Panel LP-3 labelled  " });
    expect((await localDb.fieldNotes.get(noteId))?.text).toBe("Panel LP-3 labelled");
    expect(await localDb.media.count()).toBe(0);
  });
});
