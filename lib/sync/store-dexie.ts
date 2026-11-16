// SyncStore backed by the Dexie cache, so optimistic writes run exactly the
// same reducers as the server.
import type { LocalDb } from "../db/local";
import type { SyncStore } from "./apply";

export function dexieStore(db: LocalDb): SyncStore {
  return {
    getPerson: (id) => db.people.get(id),
    getSite: (id) => db.sites.get(id),
    getTask: (id) => db.tasks.get(id),
    getReceipt: (taskId, personId) => db.taskReceipts.get([taskId, personId]),
    getTimeEntry: (id) => db.timeEntries.get(id),
    getOpenTimeEntry: (personId) =>
      db.timeEntries
        .where("personId")
        .equals(personId)
        .filter((e) => e.clockOutAt === null)
        .first(),
    getStatusUpdate: (id) => db.statusUpdates.get(id),
    getNote: (id) => db.fieldNotes.get(id),
    // Optimistic rows have no seq until the server returns its version.
    putTask: async (row) => void (await db.tasks.put(row)),
    putReceipt: async (row) => void (await db.taskReceipts.put(row)),
    putTimeEntry: async (row) => void (await db.timeEntries.put(row)),
    putStatusUpdate: async (row) => void (await db.statusUpdates.put(row)),
    putNote: async (row) => void (await db.fieldNotes.put(row)),
    putSite: async (row) => void (await db.sites.put(row)),
    // Pulled notes carry mediaUrl (never the blob path): set once the blob is uploaded.
    countPhotoNotes: (siteId) =>
      db.fieldNotes
        .filter((n) => n.siteId === siteId && n.kind === "photo" && !!(n as { mediaUrl?: string | null }).mediaUrl)
        .count(),
    touchSite: async () => {},
    // Revocations are decided by the server and arrive with the next pull.
    revoke: async () => {},
  };
}
