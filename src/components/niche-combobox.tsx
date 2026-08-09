"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { inputClass } from "@/components/ui";

/**
 * Pick an existing niche, or type a new one to create it.
 *
 * This replaced a plain `<input list=…>` datalist. Datalist is the obvious
 * answer on paper but a bad one in practice: Safari gives it no affordance at
 * all — no arrow, nothing on focus — so an existing set of niches was
 * invisible unless you happened to start typing the right prefix, which is
 * exactly how you end up with "dating", "Dating" and "dateing" side by side.
 *
 * A niche is created simply by being typed and saved; there is no separate
 * registry to keep in sync, so the option list is just the distinct values
 * already in use.
 */
export function NicheCombobox({
  name = "niche",
  options,
  defaultValue = "",
  placeholder = "e.g. dating, looksmaxing",
  id,
}: {
  name?: string;
  options: string[];
  defaultValue?: string;
  placeholder?: string;
  id?: string;
}) {
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const query = value.trim().toLowerCase();
  const matches = useMemo(
    () => options.filter((o) => o.toLowerCase().includes(query)),
    [options, query]
  );
  // Only offer to create when it isn't already an option — otherwise "dating"
  // would show both "dating" and "Create dating".
  const exact = options.some((o) => o.toLowerCase() === query);
  const canCreate = query.length > 0 && !exact;
  const rows = canCreate ? [...matches, null] : matches;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => setActive(0), [value, open]);

  const choose = (v: string) => {
    setValue(v);
    setOpen(false);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return setOpen(true);
      setActive((i) => {
        const n = rows.length;
        if (n === 0) return 0;
        return e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n;
      });
      return;
    }
    if (e.key === "Enter" && open && rows.length > 0) {
      // Enter picks the highlighted row; the "create" row is already whatever
      // is typed, so it needs no special handling beyond closing.
      e.preventDefault();
      const picked = rows[active];
      choose(picked ?? value.trim());
      return;
    }
    if (e.key === "Escape") setOpen(false);
  };

  return (
    <div ref={wrapRef} className="relative">
      <input
        ref={inputRef}
        id={id}
        name={name}
        value={value}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && rows.length > 0 ? optionId(active) : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder={placeholder}
        onChange={(e) => {
          setValue(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className={`${inputClass} pr-8`}
      />

      {/* Also the open/close affordance, which is the whole point of not
          using a datalist.

          mousedown + preventDefault rather than click: a plain click would
          blur the input, and the input's onFocus handler would then re-open
          the list a moment later, so the arrow could never actually close it. */}
      <button
        type="button"
        tabIndex={-1}
        aria-label={open ? "Close niche list" : "Show niches"}
        onMouseDown={(e) => {
          e.preventDefault();
          if (open) setOpen(false);
          else {
            setOpen(true);
            inputRef.current?.focus();
          }
        }}
        className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-neutral-400 hover:text-neutral-700"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-40 max-h-56 animate-fade-up overflow-y-auto rounded-xl bg-surface py-1 shadow-raised ring-1 ring-hairline inset-shadow-highlight"
        >
          {rows.length === 0 && (
            <li className="px-3 py-2 text-xs text-neutral-400">
              No niches yet — type one to create it.
            </li>
          )}
          {rows.map((opt, i) =>
            opt === null ? (
              <li key="__create">
                <button
                  type="button"
                  id={optionId(i)}
                  role="option"
                  aria-selected={active === i}
                  // mousedown, not click: the input's blur would otherwise
                  // close the list before click ever lands.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(value.trim());
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-sm transition-colors ${
                    active === i ? "bg-neutral-900/[0.04]" : ""
                  }`}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="shrink-0 text-success">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  <span className="text-neutral-500">Create</span>
                  <span className="truncate font-medium text-neutral-900">{value.trim()}</span>
                </button>
              </li>
            ) : (
              <li key={opt}>
                <button
                  type="button"
                  id={optionId(i)}
                  role="option"
                  aria-selected={active === i}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(opt);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                    active === i ? "bg-neutral-900/[0.04]" : ""
                  }`}
                >
                  <span className="truncate text-neutral-800">{opt}</span>
                  {value.trim().toLowerCase() === opt.toLowerCase() && (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0 text-accent">
                      <path d="m5 13 4 4L19 7" />
                    </svg>
                  )}
                </button>
              </li>
            )
          )}
          {value.trim() !== "" && (
            <li className="mt-1 border-t border-hairline">
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose("");
                }}
                className="w-full px-3 py-1.5 text-left text-xs text-neutral-400 transition-colors hover:text-neutral-700"
              >
                Clear
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
