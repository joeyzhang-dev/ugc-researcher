"use client";

import type { ReactNode } from "react";

/** Anchor that opens Discord links in the desktop app with a web fallback —
 *  the same trick the old discord-crm dashboard used: never navigate this page
 *  to discord://, fire the OS handler from a hidden iframe, and if the app
 *  hasn't grabbed focus within ~1.2s open the web URL instead. Modified-clicks
 *  (cmd/ctrl/shift/middle) fall through to normal browser behavior. */
export function DiscordLink({
  href,
  className,
  title,
  children,
}: {
  href: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
        e.preventDefault();
        const app = href.replace(/^https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com/i, "discord://-");
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          window.removeEventListener("blur", finish);
          document.removeEventListener("visibilitychange", finish);
          clearTimeout(timer);
        };
        window.addEventListener("blur", finish);
        document.addEventListener("visibilitychange", finish);
        const timer = setTimeout(() => {
          if (done) return;
          finish();
          window.open(href, "_blank", "noopener");
        }, 1200);
        // Top-frame navigation carries the click's user activation, so Chrome
        // reliably shows the "open Discord?" prompt (a hidden-iframe launch is
        // silently blocked in current Chrome and we'd always fall back to
        // web). External protocols never actually navigate the page away.
        window.location.href = app;
      }}
    >
      {children}
    </a>
  );
}
