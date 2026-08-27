"use server";

import { timingSafeEqual } from "node:crypto";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Shortest password this will accept.
 *
 * A single shared secret that grants admin is only as safe as its length: it
 * has no account behind it to lock out, and a server action has no natural
 * rate limit on a serverless host. 24 random characters is far past brute
 * force, and refusing to run below that is the only guard that actually holds —
 * unlike a counter that resets with every cold start.
 */
const MIN_ADMIN_PASSWORD_LENGTH = 24;

/** Whether the shared-secret login is configured. Drives whether the button is
 *  rendered at all, so an unconfigured deployment shows no dead control. */
export async function adminPasswordLoginEnabled(): Promise<boolean> {
  const secret = process.env.ADMIN_PASSWORD ?? "";
  return Boolean(process.env.ADMIN_LOGIN_EMAIL) && secret.length >= MIN_ADMIN_PASSWORD_LENGTH;
}

/** Constant-time compare that does not leak length through early return. */
function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a comparison so a wrong length is not measurably faster.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Sign in with a shared admin password, no email.
 *
 * The password is compared against ADMIN_PASSWORD; on a match the server mints
 * a genuine Supabase session for ADMIN_LOGIN_EMAIL using the service role, via
 * a single-use link it generates and immediately redeems. Nothing here fakes
 * authentication or bypasses the database — RLS, is_staff(), is_admin() and the
 * MFA gate all behave exactly as they do for a normal sign-in, because the
 * session is a normal session.
 *
 * The trade this makes, deliberately: one shared secret means no per-person
 * attribution. Whoever used it is recorded as ADMIN_LOGIN_EMAIL.
 */
export async function signInAsAdmin(formData: FormData) {
  const password = String(formData.get("password") ?? "");
  const expected = process.env.ADMIN_PASSWORD ?? "";
  const email = process.env.ADMIN_LOGIN_EMAIL ?? "";

  const fail = (message: string) => redirect(`/login?error=${encodeURIComponent(message)}`);

  if (!email || expected.length < MIN_ADMIN_PASSWORD_LENGTH) {
    fail(
      `Admin password login is not configured. Set ADMIN_LOGIN_EMAIL and an ADMIN_PASSWORD of at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`
    );
  }
  if (!secretMatches(password, expected)) fail("Wrong admin password");

  // Mint a real session: generate a single-use link for the account, then
  // redeem it through the cookie-backed client so the session lands in the
  // browser the same way a password sign-in would.
  const admin = createAdminClient();
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError || !link?.properties?.hashed_token) {
    fail(linkError?.message ?? `Could not start a session for ${email}`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({
    type: "magiclink",
    token_hash: link!.properties!.hashed_token,
  });
  if (error) fail(error.message);

  // A shared password must not skip a second factor the account has enrolled.
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel === "aal1" && aal?.nextLevel === "aal2") {
    redirect("/login/mfa");
  }
  redirect("/research");
}

export async function signIn(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }

  // Users with a verified authenticator must complete the TOTP step.
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel === "aal1" && aal?.nextLevel === "aal2") {
    redirect("/login/mfa");
  }
  redirect("/research");
}

export async function verifyMfa(formData: FormData) {
  const code = String(formData.get("code") ?? "").trim();
  if (!/^\d{6}$/.test(code)) {
    redirect(`/login/mfa?error=${encodeURIComponent("Enter the 6-digit code from your authenticator app")}`);
  }

  const supabase = await createClient();
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const factor = factors?.totp?.[0];
  if (!factor) redirect("/research");

  const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
    factorId: factor.id,
  });
  if (challengeError || !challenge) {
    redirect(`/login/mfa?error=${encodeURIComponent(challengeError?.message ?? "Challenge failed")}`);
  }

  const { error } = await supabase.auth.mfa.verify({
    factorId: factor.id,
    challengeId: challenge.id,
    code,
  });
  if (error) {
    redirect(`/login/mfa?error=${encodeURIComponent("Invalid code — try again")}`);
  }
  redirect("/research");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
