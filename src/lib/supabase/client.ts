import { createBrowserClient } from "@supabase/ssr";

/** Browser client (anon key only) — used for the MFA enroll/verify flows. */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
