"use client";
// Text, voice and photo notes. Media is stored as a Blob on the device first
// (works offline) and uploaded by the media queue once the note has synced.
import { useLiveQuery } from "dexie-react-hooks";
import { Mic, Square } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { usePendingRefs } from "@/components/field/hooks";
import { PhotoInput, useObjectUrl } from "@/components/field/photo-input";
import { BigButton, Chip, Field, inputClass, PageTitle, Panel, WaitingMarker } from "@/components/field/ui";
import { formatTime, useMeta } from "@/components/use-local";
import { localDb, type MediaItem } from "@/lib/db/local";
import { MAX_VOICE_SECONDS } from "@/lib/domain";
import { canRecordAudio, startRecording, type Recorder, type Recording } from "@/lib/media/recorder";
import { saveNote } from "@/lib/sync/media";
import type { FieldNoteRow } from "@/lib/sync/reducers";

export default function NotesPage() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <Notes />
    </Suspense>
  );
}

type Kind = "text" | "voice" | "photo";

function Notes() {
  const taskId = useSearchParams().get("taskId");
  const meta = useMeta();
  const actorId = meta?.actorId ?? null;
  const pending = usePendingRefs(actorId);
  const [kind, setKind] = useState<Kind>("text");
  const [siteId, setSiteId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [recording, setRecording] = useState<Recording | null>(null);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const data = useLiveQuery(async () => {
    if (!actorId) return null;
    const [task, sites, notes, media, entries] = await Promise.all([
      taskId ? localDb.tasks.get(taskId) : Promise.resolve(undefined),
      localDb.sites.toArray(),
      localDb.fieldNotes.where("personId").equals(actorId).toArray(),
      localDb.media.toArray(),
      localDb.timeEntries.where("personId").equals(actorId).toArray(),
    ]);
    const clockedIn = entries.find((e) => e.clockOutAt === null)?.siteId;
    return {
      task,
      sites: sites.sort((a, b) => a.name.localeCompare(b.name)),
      siteNames: new Map(sites.map((s) => [s.id, s.name])),
      defaultSite: task?.siteId ?? clockedIn ?? sites[0]?.id ?? null,
      notes: notes.sort((a, b) => +b.createdAt - +a.createdAt),
      media: new Map(media.map((m) => [m.noteId, m])),
    };
  }, [actorId, taskId]);

  if (!data) return <p>Loading…</p>;
  const site = siteId ?? data.defaultSite;
  const ready = !!site && (kind === "text" ? !!text.trim() : kind === "voice" ? !!recording : !!photo);

  async function save() {
    if (!site || !ready) return;
    setError(null);
    try {
      if (kind === "text") await saveNote({ kind, siteId: site, taskId, text });
      else if (kind === "voice" && recording)
        await saveNote({ kind, siteId: site, taskId, text: text || null, media: { blob: recording.blob, mimeType: recording.mimeType, durationSec: recording.durationSec } });
      else if (kind === "photo" && photo)
        await saveNote({ kind, siteId: site, taskId, text: text || null, media: { blob: photo, mimeType: "image/jpeg" } });
      setText("");
      setRecording(null);
      setPhoto(null);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <PageTitle sub={data.task ? `For: ${data.task.title}` : undefined}>Notes</PageTitle>

      <Panel>
        <div className="flex gap-2" role="group" aria-label="Note type">
          {(["text", "voice", "photo"] as const).map((k) => (
            <Chip key={k} active={kind === k} onClick={() => setKind(k)} className="flex-1 capitalize" data-testid={`kind-${k}`}>
              {k}
            </Chip>
          ))}
        </div>

        {!data.task && (
          <Field label="Site">
            <select className={inputClass} value={site ?? ""} onChange={(e) => setSiteId(e.target.value)}>
              {data.sites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
        )}

        {kind === "voice" && <VoiceRecorder recording={recording} onRecording={setRecording} />}
        {kind === "photo" && <PhotoCapture photo={photo} onPhoto={setPhoto} />}

        <Field label={kind === "text" ? "Note" : "Caption (optional)"}>
          <textarea className={inputClass} rows={kind === "text" ? 4 : 2} value={text} onChange={(e) => setText(e.target.value)} data-testid="note-text" />
        </Field>
        <BigButton disabled={!ready} onClick={save} data-testid="save-note">
          Save note
        </BigButton>
        {saved && <p className="font-semibold text-green-800">Saved on this device.</p>}
        {error && <p className="font-semibold text-red-700">{error}</p>}
      </Panel>

      <section className="space-y-2">
        <h2 className="text-xl font-bold">My notes ({data.notes.length})</h2>
        <ul className="space-y-2">
          {data.notes.map((n) => (
            <NoteItem
              key={n.id}
              note={n}
              media={data.media.get(n.id)}
              siteName={data.siteNames.get(n.siteId)}
              pending={pending.notes.has(n.id) || n.seq === undefined}
            />
          ))}
        </ul>
      </section>
    </>
  );
}

function VoiceRecorder({ recording, onRecording }: { recording: Recording | null; onRecording: (r: Recording | null) => void }) {
  const [rec, setRec] = useState<Recorder | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const startedAt = useRef(0);
  const url = useObjectUrl(recording?.blob);

  useEffect(() => {
    if (!rec) return;
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 250);
    return () => window.clearInterval(t);
  }, [rec]);

  if (!canRecordAudio()) return <p className="font-semibold text-red-700">This browser can&apos;t record audio.</p>;

  async function start() {
    setError(null);
    onRecording(null);
    try {
      const r = await startRecording();
      startedAt.current = Date.now();
      setElapsed(0);
      setRec(r);
      r.done.then(onRecording, (e: Error) => setError(e.message)).finally(() => setRec(null));
    } catch (e) {
      setError(e instanceof Error ? `Microphone: ${e.message}` : "Microphone unavailable");
    }
  }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  return (
    <div className="space-y-2">
      {rec ? (
        <BigButton tone="danger" className="min-h-16 text-xl" onClick={() => rec.stop()} data-testid="stop-recording">
          <Square className="size-6" aria-hidden /> Stop · {fmt(elapsed)} / {fmt(MAX_VOICE_SECONDS)}
        </BigButton>
      ) : (
        <BigButton tone="primary" className="min-h-16 text-xl" onClick={start} data-testid="start-recording">
          <Mic className="size-6" aria-hidden /> {recording ? "Record again" : "Record voice note"}
        </BigButton>
      )}
      <p className="text-sm text-slate-600">Up to {MAX_VOICE_SECONDS / 60} minutes. Stops automatically.</p>
      {recording && url && (
        <div className="space-y-1">
          <audio controls src={url} className="w-full" />
          <p className="text-sm text-slate-700">
            {recording.durationSec.toFixed(1)} s · {(recording.blob.size / 1024).toFixed(0)} KB · {recording.mimeType}
          </p>
        </div>
      )}
      {error && <p className="font-semibold text-red-700">{error}</p>}
    </div>
  );
}

function PhotoCapture({ photo, onPhoto }: { photo: Blob | null; onPhoto: (b: Blob | null) => void }) {
  const url = useObjectUrl(photo);
  return (
    <div className="space-y-2">
      {url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="Photo to attach" className="max-h-72 w-full rounded-lg object-contain" />
      )}
      <PhotoInput onPhoto={onPhoto} label={photo ? "Retake photo" : "Take photo"} tone={photo ? "neutral" : "primary"} />
      {photo && <p className="text-sm text-slate-700">{(photo.size / 1024).toFixed(0)} KB (compressed)</p>}
    </div>
  );
}

function NoteItem({ note, media, siteName, pending }: { note: FieldNoteRow; media: MediaItem | undefined; siteName?: string; pending: boolean }) {
  const localUrl = useObjectUrl(note.blobUrl ? null : media?.blob);
  const src = note.blobUrl ?? localUrl;
  const uploadState =
    note.kind === "text" ? null : note.blobUrl ? "uploaded" : media?.status === "uploaded" ? "uploaded, confirming" : "waiting to upload";
  return (
    <li className="space-y-2 rounded-xl border-2 border-slate-300 bg-white p-3" data-testid="note-item">
      <div className="flex flex-wrap items-center gap-2 text-base">
        <span className="font-bold capitalize">{note.kind}</span>
        <span className="text-slate-700">{formatTime(note.createdAt)}</span>
        <span className="text-slate-700">{siteName}</span>
        {pending && <WaitingMarker />}
        {uploadState && uploadState !== "uploaded" && <WaitingMarker label={uploadState} />}
      </div>
      {note.text && <p className="whitespace-pre-wrap">{note.text}</p>}
      {note.kind === "voice" && src && <audio controls src={src} className="w-full" preload="none" />}
      {note.kind === "photo" && src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={note.text ?? "Field photo"} className="max-h-60 rounded-lg object-contain" />
      )}
      {media?.lastError && !note.blobUrl && (
        <p className="text-sm text-red-700">
          Upload attempt {media.attempts} failed: {media.lastError}
        </p>
      )}
      {note.blobUrl && (
        <a href={note.blobUrl} target="_blank" rel="noopener noreferrer" className="block truncate text-sm text-blue-800 underline" data-testid="blob-url">
          {note.blobUrl}
        </a>
      )}
    </li>
  );
}
