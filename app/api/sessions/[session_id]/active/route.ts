import { setActiveSession } from "@/lib/firestore";
import { requireUser } from "@/lib/route-utils";
import { safeJsonify } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(_req: Request, ctx: { params: Promise<{ session_id: string }> }) {
  const { session_id } = await ctx.params;
  const { user, err } = await requireUser();
  if (err) return err;
  await setActiveSession(user.id, session_id);
  return safeJsonify({ ok: true });
}
