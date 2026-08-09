"use client";

import { useRef, useState } from "react";

const PlayGlyph = () => (
  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="m10 9 5 3-5 3V9Z" />
  </svg>
);

const Spinner = () => (
  <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-30" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
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
  const [ready, setReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Callback ref: the element only exists from the moment hover mounts it, so
  // this is where playback starts. React passes null on unmount.
  const startPlayback = (v: HTMLVideoElement | null) => {
    videoRef.current = v;
    if (!v) return;
    // Guard the cross-fade against a cached video that already has a frame
    // before React's onLoadedData can attach — otherwise it stays invisible.
    if (v.readyState >= 2) setReady(true);
    v.muted = false;
    void v.play().catch(() => {
      v.muted = true;
      void v.play().catch(() => {});
    });
  };

  return (
    <span
      className="absolute inset-0 block overflow-hidden"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setReady(false);
      }}
    >
      <span
        className={`absolute inset-0 transition-transform duration-700 ${
          hovered ? "scale-[1.04]" : "scale-100"
        }`}
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
          <span className="absolute inset-0 flex items-center justify-center bg-surface-sunken text-neutral-300">
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
            onLoadedData={() => setReady(true)}
            onCanPlay={() => setReady(true)}
            className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-500 ${
              ready ? "opacity-100" : "opacity-0"
            }`}
          />
        )}
      </span>

      {/* Buffering hint while the first frame decodes; the poster shows through
          underneath, then cross-fades to the video once it can paint. */}
      {src && hovered && !ready && (
        <span className="pointer-events-none absolute bottom-1.5 right-1.5 text-white/85 drop-shadow-[0_1px_2px_rgb(9_9_11/0.5)]">
          <Spinner />
        </span>
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
      <span className={`flex items-center justify-center bg-surface-sunken text-neutral-300 ${className}`}>
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
