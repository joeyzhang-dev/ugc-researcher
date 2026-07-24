"use client";

import React from "react";
import { useFormStatus } from "react-dom";
import { buttonClass } from "@/components/ui";

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
      {pending ? pendingLabel : children}
    </button>
  );
}

const DESTRUCTIVE_BUTTON =
  "inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3.5 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50";

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
      {pending ? pendingLabel : children}
    </button>
  );
}
