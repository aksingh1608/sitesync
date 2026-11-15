// Local-development fallback only: serves files stored in .data/media when
// BLOB_READ_WRITE_TOKEN is not set. In production, media URLs point at Vercel Blob.
import { localFallbackAllowed, readLocalMedia } from "@/lib/media/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  webm: "audio/webm", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", mp3: "audio/mpeg",
  jpg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic",
};

export async function GET(_req: Request, ctx: RouteContext<"/api/media/[name]">) {
  const { name } = await ctx.params;
  if (!localFallbackAllowed()) return new Response("not found", { status: 404 });
  const data = await readLocalMedia(name);
  if (!data) return new Response("not found", { status: 404 });
  const type = TYPES[name.split(".").pop() ?? ""] ?? "application/octet-stream";
  return new Response(new Uint8Array(data), { headers: { "content-type": type, "cache-control": "private, max-age=3600" } });
}
