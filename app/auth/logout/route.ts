import { clearSessionCookie, currentUser } from "@/lib/auth";
import { deleteUser } from "@/lib/db";
import { safeJsonify } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST() {
  const user = await currentUser();
  if (user) await deleteUser(user.id);
  const resp = await safeJsonify({ ok: true });
  clearSessionCookie(resp);
  return resp;
}
