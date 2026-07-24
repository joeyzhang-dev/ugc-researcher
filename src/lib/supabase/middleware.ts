import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isCreatorSurface, isPublicPath } from "@/lib/routing";

/** Refreshes the Supabase session cookie and redirects signed-out users to /login. */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  // Public, non-staff surfaces: legacy creator portal (/c/*), OAuth callback,
  // invite redemption (/invite/*), and the authenticated creator flow (/creator
  // and /creator/*). Classification lives in `@/lib/routing` so the callback's
  // allow-list and this gate can never drift. Staff MFA routing must NOT be
  // applied to any creator surface.
  const creatorSurface = isCreatorSurface(path);
  const publicPath = isPublicPath(path);

  if (!user && !publicPath) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // The staff MFA/login gate must not touch creator surfaces — creators aren't
  // staff and shouldn't be pulled into the /login/mfa or /research flows.
  if (user && !path.startsWith("/api/jobs") && !creatorSurface) {
    // A user with a verified MFA factor must complete the TOTP challenge
    // (aal2) before reaching anything — a stolen password alone stops here.
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    const needsMfa = aal?.currentLevel === "aal1" && aal?.nextLevel === "aal2";

    if (needsMfa && path !== "/login/mfa") {
      const url = request.nextUrl.clone();
      url.pathname = "/login/mfa";
      return NextResponse.redirect(url);
    }
    if (!needsMfa && path.startsWith("/login")) {
      const url = request.nextUrl.clone();
      url.pathname = "/research";
      return NextResponse.redirect(url);
    }
  }

  return supabaseResponse;
}
