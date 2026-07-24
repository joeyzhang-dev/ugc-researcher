import { NextRequest, NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";

/**
 * Job routes accept either the cron secret (scheduled runs) or a signed-in
 * admin session (manual runs from Settings). Returns a response to send when
 * the request is NOT authorized, or null when it is.
 */
export async function authorizeJobRequest(
  request: NextRequest
): Promise<NextResponse | null> {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return null;

  try {
    const profile = await getProfile();
    if (profile?.role === "admin") return null;
  } catch {
    // fall through to 401
  }

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
