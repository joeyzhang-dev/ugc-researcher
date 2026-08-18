/**
 * Runtime bootstrap. The HTTP/1.1 forcing lives in instrumentation-node.ts —
 * split out (per the Next.js docs pattern) so the Edge middleware bundle never
 * references undici, which the Edge runtime rejects at deploy time.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
