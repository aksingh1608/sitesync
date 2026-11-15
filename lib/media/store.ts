// Server-side blob storage. Vercel Blob when BLOB_READ_WRITE_TOKEN is set;
// otherwise (local development only) files go to .data/media and are served
// by GET /api/media/[name]. Production without a token refuses uploads.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { put } from "@vercel/blob";

const LOCAL_DIR = path.join(process.cwd(), ".data", "media");

export const blobConfigured = () => !!process.env.BLOB_READ_WRITE_TOKEN;
export const localFallbackAllowed = () => process.env.NODE_ENV !== "production" || process.env.SITESYNC_LOCAL_MEDIA === "1";

export async function storeMedia(opts: { pathname: string; file: Blob; contentType: string; origin: string }) {
  if (blobConfigured()) {
    // Deterministic path + overwrite: a retried upload lands on the same URL.
    const res = await put(opts.pathname, opts.file, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: opts.contentType,
    });
    return res.url;
  }
  if (!localFallbackAllowed()) throw new Error("blob_not_configured");
  const name = opts.pathname.replaceAll("/", "_");
  await mkdir(LOCAL_DIR, { recursive: true });
  await writeFile(path.join(LOCAL_DIR, name), Buffer.from(await opts.file.arrayBuffer()));
  return `${opts.origin}/api/media/${name}`;
}

export async function readLocalMedia(name: string): Promise<Buffer | null> {
  if (!/^[\w.-]+$/.test(name)) return null;
  try {
    return await readFile(path.join(LOCAL_DIR, name));
  } catch {
    return null;
  }
}
