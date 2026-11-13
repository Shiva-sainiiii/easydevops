import { get } from "@/lib/http";
import { setNetlifyToken } from "@/lib/db";
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

  const r = await get("https://api.netlify.com/api/v1/user", {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15,
  });
  if (r.status_code !== 200) {
    return safeJsonify(
      { reply: "❌ Ye token valid nahi hai. Netlify dashboard se dubara copy karke try karo.", action: "error" },
      400
    );
  }

  const netlifyUser = r.json();
  const netlifyEmail = netlifyUser.email || netlifyUser.full_name || "connected";

  await setNetlifyToken(user.id, token, netlifyEmail);
  return safeJsonify({ ok: true, netlify_email: netlifyEmail });
}
