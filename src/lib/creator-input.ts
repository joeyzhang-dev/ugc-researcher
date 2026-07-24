import type { Platform } from "@/lib/types";

/** "@handle", "handle" or a profile URL → { platform, handle }. */
export function parseCreatorInput(raw: string): { platform: Platform; handle: string } | null {
  const input = raw.trim();
  if (!input) return null;
  try {
    const u = new URL(input.startsWith("http") ? input : `https://${input}`);
    const host = u.hostname.toLowerCase();
    if (host.includes("instagram.com")) {
      const m = u.pathname.match(/^\/([A-Za-z0-9._]+)/);
      if (m && !["p", "reel", "reels", "tv", "explore", "stories"].includes(m[1])) {
        return { platform: "instagram", handle: m[1].toLowerCase() };
      }
      return null;
    }
    if (host.includes("tiktok.com")) {
      const m = u.pathname.match(/^\/@([A-Za-z0-9._]+)/);
      return m ? { platform: "tiktok", handle: m[1].toLowerCase() } : null;
    }
  } catch {
    /* not a URL — treat as a bare handle */
  }
  const handle = input.replace(/^@/, "");
  if (!/^[A-Za-z0-9._]+$/.test(handle)) return null;
  return { platform: "instagram", handle: handle.toLowerCase() };
}
