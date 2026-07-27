"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { requireStaff } from "@/lib/auth";
import { ALL_APPS, WORKSPACE_COOKIE } from "@/lib/workspace";

const ONE_YEAR = 60 * 60 * 24 * 365;

/** Switch the active workspace. Scoping is a per-user view preference, not an
 *  authorization boundary — RLS still decides what the row queries return. */
export async function switchWorkspace(appId: string) {
  await requireStaff();
  const store = await cookies();
  if (!appId || appId === ALL_APPS) {
    store.delete(WORKSPACE_COOKIE);
  } else {
    store.set(WORKSPACE_COOKIE, appId, {
      path: "/",
      maxAge: ONE_YEAR,
      sameSite: "lax",
      httpOnly: true,
    });
  }
  revalidatePath("/", "layout");
}
