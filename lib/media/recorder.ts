// Voice notes with MediaRecorder. Supported containers differ by browser
// (Chrome/Firefox: webm/opus, iOS Safari: audio/mp4), so pick at runtime.
import { MAX_VOICE_SECONDS } from "../domain";

const AUDIO_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/aac",
  "audio/ogg;codecs=opus",
];

export function pickAudioMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return AUDIO_CANDIDATES.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? "";
}

export const canRecordAudio = () =>
  typeof window !== "undefined" &&
  typeof MediaRecorder !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia;

export type Recording = { blob: Blob; mimeType: string; durationSec: number };

export type Recorder = {
  stop: () => void;
  /** Resolves when recording ends (stop() or the 2-minute limit). */
  done: Promise<Recording>;
};

export async function startRecording(maxSeconds = MAX_VOICE_SECONDS): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const picked = pickAudioMimeType();
  const rec = new MediaRecorder(stream, {
    ...(picked ? { mimeType: picked } : {}),
    audioBitsPerSecond: 48_000, // ~720 KB for 2 minutes: well under the upload cap
  });
  const chunks: Blob[] = [];
  const started = performance.now();
  rec.addEventListener("dataavailable", (e) => e.data.size && chunks.push(e.data));
  const limit = window.setTimeout(() => rec.state !== "inactive" && rec.stop(), maxSeconds * 1000);
  const done = new Promise<Recording>((resolve, reject) => {
    rec.addEventListener("stop", () => {
      window.clearTimeout(limit);
      stream.getTracks().forEach((t) => t.stop());
      const mimeType = (rec.mimeType || picked || "audio/webm").split(";")[0];
      const durationSec = Math.min(maxSeconds, (performance.now() - started) / 1000);
      resolve({ blob: new Blob(chunks, { type: mimeType }), mimeType, durationSec: Math.round(durationSec * 10) / 10 });
    });
    rec.addEventListener("error", (e) => reject((e as unknown as { error?: Error }).error ?? new Error("recording failed")));
  });
  rec.start(1000);
  return { stop: () => rec.state !== "inactive" && rec.stop(), done };
}
