"use client";

import { useRef } from "react";

/** Grid-card media: shows the poster frame and autoplays the stored video —
 *  with sound — while hovered (reset on leave). Browsers only allow unmuted
 *  play after the page has had a user gesture, so the very first hover on a
 *  fresh load may fall back to muted. Falls back to the plain thumbnail — or
 *  a glyph — when the file isn't captured yet. Fills its positioned parent. */
export function HoverVideo({ src, poster }: { src: string | null; poster: string | null }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  if (!src) {
    return poster ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={poster} alt="" className="absolute inset-0 h-full w-full object-cover" />
    ) : (
      <span className="absolute inset-0 flex items-center justify-center text-neutral-300">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m10 9 5 3-5 3V9Z" /></svg>
      </span>
    );
  }
  return (
    <video
      ref={ref}
      src={src}
      poster={poster ?? undefined}
      loop
      playsInline
      preload="none"
      onMouseEnter={() => {
        const v = ref.current;
        if (!v) return;
        v.muted = false;
        void v.play().catch(() => {
          v.muted = true;
          void v.play().catch(() => {});
        });
      }}
      onMouseLeave={() => {
        const v = ref.current;
        if (v) {
          v.pause();
          v.currentTime = 0;
        }
      }}
      className="absolute inset-0 h-full w-full object-cover"
    />
  );
}
