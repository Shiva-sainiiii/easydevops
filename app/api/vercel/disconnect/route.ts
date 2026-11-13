import { clearVercelToken } from "@/lib/db";
import { requireUser } from "@/lib/route-utils";
import { safeJsonify } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST() {
  const { user, err } = await requireUser();
  if (err) return err;
  await clearVercelToken(user.id);
  return safeJsonify({ ok: true });
}
