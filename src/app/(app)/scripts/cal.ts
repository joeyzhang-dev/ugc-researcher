/* cal.com-flavored chrome (scoped to the scripts pages) --------------------
   Near-monochrome system: ink #111 actions, hairline borders, 8px radius on
   controls, 12px on cards, pill-shaped filters. Accent color is reserved for
   data (score chips) and niche tags, never for chrome. */

export const card =
  "rounded-xl border border-neutral-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.05)]";
export const cardTitle = "text-base font-semibold tracking-tight text-neutral-900";
export const calLabel = "block text-[13px] font-medium text-neutral-700";
export const calButton =
  "inline-flex h-10 items-center gap-1.5 rounded-lg bg-[#111111] px-5 text-sm font-semibold text-white transition-colors hover:bg-[#242424] disabled:bg-neutral-200 disabled:text-neutral-400";
export const pillBase = "rounded-full px-3 py-1 text-[13px] font-medium transition-colors";
export const pillIdle = `${pillBase} border border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900`;
export const pillActive = `${pillBase} border border-neutral-900 bg-neutral-900 text-white`;
export const rowPill =
  "shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium";
export const th = "px-3 py-2.5 text-left text-[13px] font-medium text-neutral-500";
export const td = "px-3 py-3 text-sm text-neutral-700";

/* Light pastel set for niches (cal.com's badge pastels), so same-day batches
   from different niches read apart at a glance. Niches are free-typed, so
   colors are dealt by position in the known-niche list rather than by name —
   stable within a page, distinct until the palette runs out. */
export const NICHE_PALETTE = [
  { pill: "border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100", active: "border-violet-600 bg-violet-600 text-white", row: "bg-violet-50 text-violet-700" },
  { pill: "border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100", active: "border-sky-600 bg-sky-600 text-white", row: "bg-sky-50 text-sky-700" },
  { pill: "border-pink-200 bg-pink-50 text-pink-700 hover:bg-pink-100", active: "border-pink-600 bg-pink-600 text-white", row: "bg-pink-50 text-pink-700" },
  { pill: "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100", active: "border-emerald-600 bg-emerald-600 text-white", row: "bg-emerald-50 text-emerald-700" },
  { pill: "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100", active: "border-amber-600 bg-amber-600 text-white", row: "bg-amber-50 text-amber-700" },
  { pill: "border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100", active: "border-orange-600 bg-orange-600 text-white", row: "bg-orange-50 text-orange-700" },
  { pill: "border-teal-200 bg-teal-50 text-teal-700 hover:bg-teal-100", active: "border-teal-600 bg-teal-600 text-white", row: "bg-teal-50 text-teal-700" },
  { pill: "border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100", active: "border-indigo-600 bg-indigo-600 text-white", row: "bg-indigo-50 text-indigo-700" },
] as const;

export type NicheColor = (typeof NICHE_PALETTE)[number];
