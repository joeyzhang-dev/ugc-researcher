import { redirect } from "next/navigation";
import { getProfile, isStaff } from "@/lib/auth";
import { signOut } from "@/app/login/actions";
import { AppNav } from "@/components/app-nav";
import { WorkspaceRail } from "@/components/workspace-rail";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { getWorkspace } from "@/lib/workspace/server";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const profile = await getProfile();
  if (!profile) redirect("/login");

  // Default deny: signed in but not staff — dead-end here rather than redirect
  // to /login, which would loop with the middleware.
  if (!isStaff(profile)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#fafafa] p-6">
        <div className="max-w-sm rounded-xl border border-neutral-200 bg-white p-6 text-center">
          <h1 className="text-lg font-semibold">No staff access</h1>
          <p className="mt-1 text-sm text-neutral-500">
            This account isn&apos;t a Trace team member.
          </p>
          <form action={signOut} className="mt-4">
            <button className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700">
              Sign out
            </button>
          </form>
        </div>
      </div>
    );
  }

  const { apps, current } = await getWorkspace();

  return (
    <div className="flex min-h-screen bg-[#fafafa]">
      <WorkspaceRail apps={apps} current={current} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-6 py-3">
          <WorkspaceSwitcher apps={apps} current={current} />
          <AppNav />
          <span className="flex items-center gap-3">
            <span className="text-[11px] text-neutral-400">{profile.email}</span>
            <form action={signOut}>
              <button
                type="submit"
                className="text-[11px] font-medium text-neutral-500 transition-colors hover:text-neutral-900"
              >
                Sign out
              </button>
            </form>
          </span>
        </header>

        <main className="px-8 py-7">
          <div className="mx-auto w-full max-w-[1720px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
