import { get } from "@/lib/http";
import { setVercelToken } from "@/lib/db";
import { readJsonBody, requireUser } from "@/lib/route-utils";
import { safeJsonify } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Manual API token paste (OAuth nahi) — save karne se pehle "who am I" call se validate
export async function POST(req: Request) {
  const { user, err } = await requireUser();
  if (err) return err;

  const body = await readJsonBody(req);
  const token = String(body.token || "").trim();
  if (!token) return safeJsonify({ reply: "❌ Token khaali hai.", action: "error" }, 400);

  const r = await get("https://api.vercel.com/v2/user", {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15,
  });
  if (r.status_code !== 200) {
    return safeJsonify(
      { reply: "❌ Ye token valid nahi hai. Vercel dashboard se dubara copy karke try karo.", action: "error" },
      400
    );
  }

  const vercelUser = r.json().user ?? {};
  const vercelUsername = vercelUser.username || vercelUser.email || "connected";

  await setVercelToken(user.id, token, vercelUsername);
  return safeJsonify({ ok: true, vercel_username: vercelUsername });
}
