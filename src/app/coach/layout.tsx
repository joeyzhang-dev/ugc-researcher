import { redirect } from "next/navigation";
import { getProfile, isCoach, isStaff } from "@/lib/auth";
import { signOut } from "@/app/login/actions";

/**
 * The coach surface: one page, no rail, no workspace switcher.
 *
 * A coach is not staff, so the `(app)` layout's rail — research pool,
 * scripts, every other coach's team — never renders for them. Staff can open
 * /coach too (to see what a coach sees, and to check a team before its coach
 * is invited); a creator-role account gets nothing here.
 */
export default async function CoachLayout({ children }: { children: React.ReactNode }) {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  if (!isCoach(profile) && !isStaff(profile)) redirect("/login");

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-black/[0.06] bg-surface">
        <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between px-6 py-3">
          <span className="text-sm font-semibold tracking-[-0.01em] text-neutral-900">
            Folk UGC <span className="font-normal text-neutral-400">· coach</span>
          </span>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[11px] text-neutral-400">{profile.email}</span>
            <form action={signOut}>
              <button className="rounded-full bg-neutral-900/[0.05] px-3 py-1 text-xs font-medium text-neutral-700 transition hover:bg-neutral-900/[0.09]">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1400px] px-6 py-7">{children}</main>
    </div>
  );
}
