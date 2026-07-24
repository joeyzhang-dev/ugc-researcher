import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trace Research",
  description: "Internal tool for studying outside UGC creators and formats",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
