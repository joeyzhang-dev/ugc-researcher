"use client";

import { useRef, useState } from "react";

const PlayGlyph = () => (
  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="m10 9 5 3-5 3V9Z" />
  </svg>
);

/** Grid-card media. Renders a lazily-decoded poster frame and only mounts the
 *  <video> element once the card is actually hovered — a page of 200 cards
 *  otherwise costs 200 live video elements, which is what made the grid crawl.
 *
 *  `no-referrer` matters: Instagram's CDN hotlink-blocks requests that carry an
 *  origin, so any thumbnail not yet copied into our storage bucket renders as a
 *  blank tile without it.
 *
 *  Plays with sound while hovered (reset on leave). Browsers only allow unmuted
 *  playback after a user gesture on the page, so the very first hover on a fresh
 *  load falls back to muted. Falls back to the poster — or a glyph — when the
 *  video file isn't captured yet or the image 404s. Fills its positioned parent. */
export function HoverVideo({ src, poster }: { src: string | null; poster: string | null }) {
  const [hovered, setHovered] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Callback ref: the element only exists from the moment hover mounts it, so
  // this is where playback starts. React passes null on unmount.
  const startPlayback = (v: HTMLVideoElement | null) => {
    videoRef.current = v;
    if (!v) return;
    v.muted = false;
    void v.play().catch(() => {
      v.muted = true;
      void v.play().catch(() => {});
    });
  };

  return (
    <span
      className="absolute inset-0 block"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {poster && !posterFailed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={poster}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setPosterFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center bg-neutral-100 text-neutral-300">
          <PlayGlyph />
        </span>
      )}

      {src && hovered && (
        <video
          ref={startPlayback}
          src={src}
          loop
          playsInline
          autoPlay
          preload="auto"
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
    </span>
  );
}

/** Small static thumbnail (table rows). Lazy-loaded, referrer-stripped so the
 *  Instagram CDN doesn't hotlink-block it, with a glyph fallback on 404. */
export function Thumb({ src, className }: { src: string | null; className: string }) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <span className={`flex items-center justify-center bg-neutral-100 text-neutral-300 ${className}`}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="m10 9 5 3-5 3V9Z" />
        </svg>
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`object-cover ${className}`}
    />
  );
}
