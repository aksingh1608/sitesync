// Shrink photos on the device before they are stored and uploaded:
// ~1600 px on the long edge, JPEG. Respects EXIF orientation.
export const PHOTO_MAX_EDGE = 1600;

export async function compressPhoto(file: Blob, maxEdge = PHOTO_MAX_EDGE, quality = 0.8): Promise<Blob> {
  let source: ImageBitmap | HTMLImageElement;
  let w: number;
  let h: number;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    source = bmp;
    [w, h] = [bmp.width, bmp.height];
  } catch {
    const img = new Image();
    const url = URL.createObjectURL(file);
    try {
      img.src = url;
      await img.decode();
    } finally {
      URL.revokeObjectURL(url);
    }
    source = img;
    [w, h] = [img.naturalWidth, img.naturalHeight];
  }
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
  if ("close" in source) source.close();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", quality));
  if (!blob) throw new Error("could not compress photo");
  return blob;
}
