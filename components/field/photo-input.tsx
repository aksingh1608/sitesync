"use client";
import { Camera } from "lucide-react";
import { useRef, useState } from "react";
import { compressPhoto } from "@/lib/media/compress";
import { BigButton, type Tone } from "./ui";

/** Opens the camera (file input with `capture`), compresses to ~1600 px JPEG. */
export function PhotoInput({
  onPhoto,
  label = "Take photo",
  tone = "neutral",
}: {
  onPhoto: (blob: Blob) => void;
  label?: string;
  tone?: Tone;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <input
        ref={ref}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        data-testid="photo-input"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setBusy(true);
          setError(null);
          try {
            onPhoto(await compressPhoto(file));
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not read photo");
          } finally {
            setBusy(false);
          }
        }}
      />
      <BigButton tone={tone} onClick={() => ref.current?.click()} disabled={busy}>
        <Camera className="size-6" aria-hidden /> {busy ? "Processing…" : label}
      </BigButton>
      {error && <p className="text-base font-semibold text-red-700">{error}</p>}
    </div>
  );
}

export function useObjectUrl(blob: Blob | null | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  const [prev, setPrev] = useState<Blob | null | undefined>(undefined);
  if (blob !== prev) {
    setPrev(blob);
    setUrl(blob ? URL.createObjectURL(blob) : null);
  }
  return url;
}
