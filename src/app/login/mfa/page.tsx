import { signOut, verifyMfa } from "../actions";
import { buttonClass, inputClass, labelClass } from "@/components/ui";

export default async function MfaPage({
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
          <h1 className="text-xl font-semibold tracking-tight">Two-factor authentication</h1>
          <p className="mt-1 text-sm text-neutral-400">Enter the code from your authenticator app</p>
        </div>

        <div className="rounded-xl border border-neutral-200 bg-white p-6">
          {error && (
            <p className="mb-4 rounded-lg border border-red-100 bg-red-50 p-2.5 text-sm text-red-700">
              {error}
            </p>
          )}
          <form action={verifyMfa} className="space-y-4">
            <div>
              <label htmlFor="code" className={labelClass}>6-digit code</label>
              <input
                id="code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                required
                autoFocus
                className={`${inputClass} text-center text-lg tracking-[0.4em]`}
              />
            </div>
            <button type="submit" className={`${buttonClass} w-full justify-center`}>
              Verify
            </button>
          </form>
        </div>

        <form action={signOut} className="mt-4 text-center">
          <button type="submit" className="text-xs text-neutral-400 underline hover:text-neutral-700">
            Sign out and start over
          </button>
        </form>
      </div>
    </main>
  );
}
