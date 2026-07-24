import { signIn } from "./actions";
import { buttonClass, inputClass, labelClass } from "@/components/ui";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center">
          <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-neutral-950 text-lg font-bold text-white">
            T
          </span>
          <h1 className="text-xl font-semibold tracking-tight">Trace UGC</h1>
          <p className="mt-1 text-sm text-neutral-400">Campaign OS — sign in to continue</p>
        </div>

        <div className="rounded-xl border border-neutral-200 bg-white p-6">
          {error && (
            <p className="mb-4 rounded-lg border border-red-100 bg-red-50 p-2.5 text-sm text-red-700">
              {error}
            </p>
          )}

          <form action={signIn} className="space-y-4">
            <div>
              <label htmlFor="email" className={labelClass}>Email</label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="password" className={labelClass}>Password</label>
              <input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
                className={inputClass}
              />
            </div>
            <button type="submit" className={`${buttonClass} w-full justify-center`}>
              Sign in
            </button>
          </form>
        </div>

        <p className="mt-4 text-center text-xs text-neutral-400">
          Accounts are created by an admin in the Supabase dashboard.
        </p>
      </div>
    </main>
  );
}
