"use client";

import React from "react";
import { useFormStatus } from "react-dom";
import { buttonClass } from "@/components/ui";

/** Inline activity indicator. Inherits the button's text color via
 *  currentColor, so it reads on ink, tinted and disabled surfaces alike. */
function Spinner() {
  return (
    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Submit button that disables itself while the server action runs —
 * double-clicking a slow form was creating duplicate records.
 */
export function SubmitButton({
  children,
  pendingLabel = "Saving…",
  className,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={className ?? buttonClass}>
      {pending ? (
        <>
          <Spinner />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}

const DESTRUCTIVE_BUTTON =
  "inline-flex items-center justify-center gap-1.5 rounded-full bg-surface px-3.5 py-2 text-sm font-medium text-danger shadow-ambient ring-1 ring-danger/[0.22] transition hover:bg-danger/[0.06] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/45 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-50";

/** Confirm-before-submit: browser confirm dialog + pending lock. Defaults to a
 *  destructive (red) style; pass `className` for non-destructive confirms. */
export function ConfirmSubmitButton({
  children,
  confirmMessage,
  pendingLabel = "Deleting…",
  className,
}: {
  children: React.ReactNode;
  confirmMessage: string;
  pendingLabel?: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      onClick={(e) => {
        if (!window.confirm(confirmMessage)) e.preventDefault();
      }}
      className={className ?? DESTRUCTIVE_BUTTON}
    >
      {pending ? (
        <>
          <Spinner />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}
