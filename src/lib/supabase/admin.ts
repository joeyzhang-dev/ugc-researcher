import { createClient as createSupabaseClient, SupabaseClient } from "@supabase/supabase-js";
import { withNetworkRetry } from "@/lib/fetch-retry";

/**
 * Service-role client for server-side jobs (bypasses RLS).
 * NEVER import from client components — the service role key is server-only.
 *
 * Its fetch retries momentary network failures: scrape jobs hold this client
 * through dozens of large storage uploads, and the first call after a stale
 * keep-alive socket used to throw "TypeError: fetch failed" and fail the
 * whole creator (see fetch-retry.ts).
 */
export function createAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createSupabaseClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: withNetworkRetry(fetch) },
  });
}
