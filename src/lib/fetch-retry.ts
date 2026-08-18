/**
 * Retry wrapper for fetch-compatible functions, aimed at one failure mode:
 * network-level rejections ("TypeError: fetch failed") from a keep-alive
 * socket that went stale between requests. A research scrape holds its
 * Supabase connection through dozens of large storage uploads, and the first
 * PostgREST call after a reset socket used to throw raw and fail the whole
 * creator. Those failures are momentary — the retry lands on a fresh socket.
 *
 * HTTP error responses are answers, not failures, and pass straight through.
 * Deliberate aborts (AbortError) are never retried.
 */

const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A thrown network failure — matched by name, not instanceof, because Next's
 *  patched fetch can throw TypeErrors from another realm. Aborts excluded. */
function isNetworkError(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === "TypeError" || name === "FetchError";
}

export function withNetworkRetry(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init?) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetchImpl(input, init);
      } catch (e) {
        if (!isNetworkError(e) || attempt >= MAX_ATTEMPTS - 1) throw e;
        await sleep(RETRY_BACKOFF_MS * (attempt + 1));
      }
    }
  };
}
