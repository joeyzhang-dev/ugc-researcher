import { adminPasswordLoginEnabled, signIn, signInAsAdmin } from "./actions";
import { buttonClass, inputClass, labelClass } from "@/components/ui";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  // Rendered only when configured, so an unconfigured deployment never shows a
  // control that cannot work.
  const adminLogin = await adminPasswordLoginEnabled();

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-canvas p-6">
      {/* Ambient machined backdrop: a soft accent bloom over a masked hairline
          grid. Static (no blur, no entry animation) so it stays cheap. */}
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
        {/* Brand moment — the one screen that earns generous space + larger type. */}
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-neutral-950 text-xl font-bold text-white shadow-ambient ring-1 ring-hairline inset-shadow-highlight">
            B
          </span>
          <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-neutral-900">
            bludgc
          </h1>
          <p className="mt-2 text-sm text-neutral-500">
            Creator &amp; format study — sign in to continue
          </p>
        </div>

        {/* Double-bezel sign-in card. */}
        <div className="rounded-[20px] bg-surface-muted p-1.5 shadow-ambient ring-1 ring-hairline">
          <div className="rounded-2xl bg-surface p-7 ring-1 ring-hairline inset-shadow-highlight">
            {error && (
              <p className="mb-4 rounded-xl bg-danger/[0.08] p-3 text-sm text-danger ring-1 ring-danger/[0.22]">
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
                  placeholder="you@nozomio.com"
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
                  placeholder="••••••••"
                  className={inputClass}
                />
              </div>
              <button type="submit" className={`${buttonClass} mt-1 w-full justify-center`}>
                Sign in
              </button>
            </form>

            {adminLogin && (
              <>
                <div className="my-5 flex items-center gap-3" aria-hidden>
                  <span className="h-px flex-1 bg-hairline" />
                  <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                    or
                  </span>
                  <span className="h-px flex-1 bg-hairline" />
                </div>

                <form action={signInAsAdmin} className="space-y-3">
                  <div>
                    <label htmlFor="adminPassword" className={labelClass}>
                      Admin password
                    </label>
                    <input
                      id="adminPassword"
                      name="password"
                      type="password"
                      required
                      autoComplete="off"
                      placeholder="••••••••••••"
                      className={inputClass}
                    />
                  </div>
                  <button
                    type="submit"
                    className="inline-flex w-full items-center justify-center rounded-xl px-4 py-2.5 text-sm font-medium text-neutral-700 ring-1 ring-inset ring-hairline transition hover:bg-neutral-900/[0.03] hover:text-neutral-900 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
                  >
                    Sign in as admin
                  </button>
                </form>
              </>
            )}
          </div>
        </div>

        <p className="mt-5 text-center text-xs text-neutral-400">
          Accounts are created by an admin in the Supabase dashboard.
        </p>
      </div>
    </main>
  );
}
