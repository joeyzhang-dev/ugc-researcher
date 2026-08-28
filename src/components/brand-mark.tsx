/**
 * The bludgc mark.
 *
 * The artwork itself (public/logo.png), not a redrawn approximation. A first
 * pass hand-authored the character as inline SVG so it could inherit
 * `currentColor` and scale for free — but the result was mush below about
 * 100px, and a logo that is unrecognisable at rail size is not a logo. The
 * real file is legible at 24px, which is the only test that matters here.
 *
 * Consequence worth knowing: the art is black line-work on a near-white
 * ground, so it needs a LIGHT chip behind it. Every call site pairs it with
 * `brandChipClass` rather than the dark square the old "B" glyph used — on
 * black, black hair simply disappears.
 */

/** Light chip the mark sits on. Exported so the login hero and the workspace
 *  rail cannot drift apart on it. */
export const brandChipClass =
  "flex items-center justify-center overflow-hidden bg-white shadow-ambient ring-1 ring-hairline";

export function BrandMark({
  size = 40,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/logo.png"
      alt=""
      width={size}
      height={size}
      decoding="async"
      className={className}
      style={{ width: size, height: size, objectFit: "contain" }}
    />
  );
}
