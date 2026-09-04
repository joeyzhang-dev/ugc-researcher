import type { Metadata } from "next";
import localFont from "next/font/local";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

/**
 * Labil Grotesk — the typeface folk's /admin console (blud) runs on.
 *
 * Loaded here rather than inside the console because `next/font/local` has to
 * be called at module scope in a layout. Only surfaces scoped `.ag` reference
 * it; everything still on the older kit keeps Geist, so this is additive.
 *
 * The four files are variable ranges, not four static cuts — the weight bands
 * below are what map `font-medium` / `font-semibold` onto the right file.
 */
const labil = localFont({
  src: [
    { path: "../../public/fonts/LabilGrotesk-50Regular.woff2", weight: "100 450", style: "normal" },
    { path: "../../public/fonts/LabilGrotesk-60Medium.woff2", weight: "451 650", style: "normal" },
    { path: "../../public/fonts/LabilGrotesk-70Bold.woff2", weight: "651 750", style: "normal" },
    { path: "../../public/fonts/LabilGrotesk-80Black.woff2", weight: "751 900", style: "normal" },
  ],
  variable: "--font-labil",
  display: "swap",
  preload: true,
});

export const metadata: Metadata = {
  title: "bludgc",
  description: "Internal tool for studying outside UGC creators and formats",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} ${labil.variable}`}>
      <body>{children}</body>
    </html>
  );
}
