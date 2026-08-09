import { redirect } from "next/navigation";
import { getProfile, isStaff } from "@/lib/auth";
import { signOut } from "@/app/login/actions";
import { WorkspaceRail } from "@/components/workspace-rail";
import { getWorkspace } from "@/lib/workspace/server";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const profile = await getProfile();
  if (!profile) redirect("/login");

  // Default deny: signed in but not staff — dead-end here rather than redirect
  // to /login, which would loop with the middleware.
  if (!isStaff(profile)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas p-6">
        <div className="w-full max-w-sm rounded-[18px] bg-surface-muted p-1.5 shadow-ambient ring-1 ring-hairline">
          <div className="rounded-xl bg-surface p-6 text-center inset-shadow-highlight ring-1 ring-hairline">
            <span className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-danger/[0.1] text-danger ring-1 ring-danger/[0.22]">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="5" y="11" width="14" height="9" rx="2" />
                <path d="M8 11V8a4 4 0 0 1 8 0v3" />
              </svg>
            </span>
            <h1 className="text-lg font-semibold tracking-[-0.01em] text-neutral-900">No staff access</h1>
            <p className="mt-1 text-sm text-neutral-500">
              This account isn&apos;t a Trace team member.
            </p>
            <form action={signOut} className="mt-5">
              <button className="inline-flex w-full items-center justify-center rounded-full bg-neutral-900 px-4 py-2 text-sm font-medium text-white shadow-ambient transition hover:bg-neutral-800 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  const { apps, current } = await getWorkspace();

  return (
    <div className="flex min-h-screen bg-canvas">
      <WorkspaceRail apps={apps} current={current} email={profile.email} />

      <main className="min-w-0 flex-1 px-8 py-7">
        <div className="mx-auto w-full max-w-[1720px]">{children}</div>
      </main>
    </div>
  );
}
