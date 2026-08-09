import { signOut, verifyMfa } from "../actions";
import { buttonClass, inputClass, labelClass } from "@/components/ui";

export default async function MfaPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-canvas p-6">
      {/* Same ambient backdrop as /login — MFA is the second step of one flow,
          so it must not look like a different product. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div
          className="absolute left-1/2 top-[-12%] h-[560px] w-[880px] -translate-x-1/2 rounded-full"
          style={{
            background:
              "radial-gradient(closest-side, color-mix(in oklab, var(--color-accent) 13%, transparent), transparent)",
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(var(--color-hairline) 1px, transparent 1px), linear-gradient(90deg, var(--color-hairline) 1px, transparent 1px)",
            backgroundSize: "46px 46px",
            maskImage: "radial-gradient(closest-side at 50% 38%, black, transparent 76%)",
            WebkitMaskImage: "radial-gradient(closest-side at 50% 38%, black, transparent 76%)",
          }}
        />
      </div>

      <div className="relative w-full max-w-[400px] animate-fade-up">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-neutral-950 text-xl font-bold text-white shadow-ambient ring-1 ring-hairline inset-shadow-highlight">
            T
          </span>
          <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-neutral-900">
            Two-factor authentication
          </h1>
          <p className="mt-2 text-sm text-neutral-500">
            Enter the code from your authenticator app
          </p>
        </div>

        <div className="rounded-[20px] bg-surface-muted p-1.5 shadow-ambient ring-1 ring-hairline">
          <div className="rounded-2xl bg-surface p-7 ring-1 ring-hairline inset-shadow-highlight">
            {error && (
              <p className="mb-4 rounded-xl bg-danger/[0.08] p-3 text-sm text-danger ring-1 ring-danger/[0.22]">
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
                  className={`${inputClass} text-center font-mono text-lg tracking-[0.4em]`}
                />
              </div>
              <button type="submit" className={`${buttonClass} w-full justify-center`}>
                Verify
              </button>
            </form>
          </div>
        </div>

        <form action={signOut} className="mt-5 text-center">
          <button
            type="submit"
            className="rounded-full px-3 py-1 text-xs text-neutral-400 transition hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          >
            Sign out and start over
          </button>
        </form>
      </div>
    </main>
  );
}
