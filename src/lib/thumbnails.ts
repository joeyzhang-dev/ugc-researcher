import { SupabaseClient } from "@supabase/supabase-js";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Copy an image from Instagram's CDN (signed URL, expires within days) into
 * the public `thumbnails` storage bucket at the given path prefix and return
 * its permanent public URL. Best-effort: returns null on any failure —
 * callers must treat these images as optional.
 */
export async function captureImage(
  supabase: SupabaseClient,
  pathPrefix: string,
  imageUrl: string
): Promise<string | null> {
  try {
    const res = await fetch(imageUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    if (!contentType.startsWith("image/")) return null;

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_BYTES) return null;

    const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
    const path = `${pathPrefix}.${ext}`;

    const { error } = await supabase.storage
      .from("thumbnails")
      .upload(path, buffer, { contentType, upsert: true });
    if (error) return null;

    const { data } = supabase.storage.from("thumbnails").getPublicUrl(path);
    return data.publicUrl ?? null;
  } catch {
    return null;
  }
}

/** Reel cover image. */
export function captureThumbnail(supabase: SupabaseClient, videoId: string, imageUrl: string) {
  return captureImage(supabase, `videos/${videoId}`, imageUrl);
}

const VIDEO_FETCH_TIMEOUT_MS = 60_000;
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;

/**
 * Copy the reel's video file from the platform CDN (signed URL, expires within
 * days) into the public `videos` storage bucket and return its permanent public
 * URL. Best-effort like captureImage: returns null on any failure — the review
 * UI falls back to the thumbnail + original link.
 */
export async function captureVideo(
  supabase: SupabaseClient,
  videoId: string,
  videoUrl: string
): Promise<string | null> {
  try {
    const res = await fetch(videoUrl, { signal: AbortSignal.timeout(VIDEO_FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;

    // IG serves video/mp4; TikTok download URLs sometimes say octet-stream.
    const contentType = res.headers.get("content-type") ?? "video/mp4";
    if (!contentType.startsWith("video/") && contentType !== "application/octet-stream") return null;

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_VIDEO_BYTES) return null;

    const ext = contentType.includes("webm") ? "webm" : "mp4";
    const path = `${videoId}.${ext}`;

    const { error } = await supabase.storage
      .from("videos")
      .upload(path, buffer, { contentType: contentType.startsWith("video/") ? contentType : "video/mp4", upsert: true });
    if (error) return null;

    const { data } = supabase.storage.from("videos").getPublicUrl(path);
    return data.publicUrl ?? null;
  } catch {
    return null;
  }
}

/** Creator profile picture. */
export function captureAvatar(supabase: SupabaseClient, creatorId: string, imageUrl: string) {
  return captureImage(supabase, `avatars/${creatorId}`, imageUrl);
}
