/** Media types the upload route accepts, and the file extension used in storage. */
const EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};
export const baseMime = (m: string) => m.split(";")[0].trim().toLowerCase();
export const extFor = (mime: string): string | null => EXT[baseMime(mime)] ?? null;
