import { clearSessionCookie, currentUser } from "@/lib/auth";
import { bumpSessionVersion } from "@/lib/db";
import { safeJsonify } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Saare devices/browsers se logout (session revocation). `/auth/logout` ki tarah data delete nahi karta —
 * sirf session_version badhata hai, isse purani saari cookies invalid ho jati hain.
 */
export async function POST() {
  const user = await currentUser();
  if (!user) return safeJsonify({ ok: true });
  await bumpSessionVersion(user.id);
  const resp = await safeJsonify({ ok: true });
  clearSessionCookie(resp);
  return resp;
}
