import { appendMessage } from "@/lib/firestore";
import { readJsonBody, requireUser } from "@/lib/route-utils";
import { safeJsonify } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Ek message ({role, content, actionClass, ts, ...}) session mein append. */
export async function POST(req: Request, ctx: { params: Promise<{ session_id: string }> }) {
  const { session_id } = await ctx.params;
  const { user, err } = await requireUser();
  if (err) return err;
  const entry = await readJsonBody(req);
  await appendMessage(user.id, session_id, entry);
  return safeJsonify({ ok: true });
}
