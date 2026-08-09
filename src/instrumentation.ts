/**
 * Force HTTP/1.1 for all outbound server fetches.
 *
 * Supabase serves HTTP/2, and Node 26's fetch negotiates it. Undici pools the
 * h2 session per origin, but a session that gets torn down mid-flight is not
 * evicted from the pool — every later request on that origin then throws
 * `TypeError: fetch failed` with cause `ERR_HTTP2_INVALID_SESSION`
 * ("The session has been destroyed") for the life of the process.
 *
 * A research scrape reliably triggers it: it uploads ~20 mp4s to Storage, and
 * once one of those large uploads kills the session, every Supabase call after
 * it fails. In practice that meant the dev server would serve one scrape and
 * then 307 every authenticated page to /login until it was restarted.
 *
 * Retrying does not help — the poisoned session stays pooled — so the fix is
 * to not speak h2 at all. Keep-alive is left long since the same connection is
 * reused across a scrape's long run of storage uploads.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { Agent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(
    new Agent({
      allowH2: false,
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 600_000,
    })
  );
}
