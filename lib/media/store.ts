// Server-side blob storage in a PRIVATE Vercel Blob store. Auth: on Vercel the
// SDK uses OIDC + BLOB_STORE_ID (set when the store is connected to the project);
// elsewhere BLOB_READ_WRITE_TOKEN. Without either, local development stores
// files in .data/media. Production without a store refuses uploads.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { get, put } from "@vercel/blob";

const LOCAL_DIR = path.join(process.cwd(), ".data", "media");

export const blobConfigured = () => !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
export const localFallbackAllowed = () =>
  !blobConfigured() && (process.env.NODE_ENV !== "production" || process.env.SITESYNC_LOCAL_MEDIA === "1");

const localFile = (pathname: string) => path.join(LOCAL_DIR, pathname.replaceAll("/", "_"));

/** Stores the blob and returns its pathname (never a URL: the store is private). */
export async function storeMedia(opts: { pathname: string; file: Blob; contentType: string }): Promise<string> {
  if (blobConfigured()) {
    // Deterministic path + overwrite: a retried upload lands on the same pathname.
    const res = await put(opts.pathname, opts.file, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: opts.contentType,
    });
    return res.pathname;
  }
  if (!localFallbackAllowed()) throw new Error("blob_not_configured");
  await mkdir(LOCAL_DIR, { recursive: true });
  await writeFile(localFile(opts.pathname), Buffer.from(await opts.file.arrayBuffer()));
  return opts.pathname;
}

export type MediaRead =
  | { status: 200; body: ReadableStream<Uint8Array> | Uint8Array; contentType: string; size: number; etag: string }
  | { status: 304; etag: string }
  | null;

export async function readMedia(pathname: string, contentType: string, ifNoneMatch?: string): Promise<MediaRead> {
  if (blobConfigured()) {
    const r = await get(pathname, { access: "private", ifNoneMatch });
    if (!r) return null;
    if (r.statusCode === 304) return { status: 304, etag: r.blob.etag };
    return { status: 200, body: r.stream, contentType: r.blob.contentType, size: r.blob.size, etag: r.blob.etag };
  }
  if (!localFallbackAllowed()) return null;
  try {
    const data = new Uint8Array(await readFile(localFile(pathname)));
    const etag = `"${data.byteLength}-${pathname.length}"`;
    if (ifNoneMatch === etag) return { status: 304, etag };
    return { status: 200, body: data, contentType, size: data.byteLength, etag };
  } catch {
    return null;
  }
}
