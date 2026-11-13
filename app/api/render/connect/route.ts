import { get } from "@/lib/http";
import { setRenderToken } from "@/lib/db";
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

  const r = await get("https://api.render.com/v1/users", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    timeout: 15,
  });
  if (r.status_code !== 200) {
    return safeJsonify(
      { reply: "❌ Ye API key valid nahi hai. Render dashboard se dubara copy karke try karo.", action: "error" },
      400
    );
  }

  let renderUser = r.json();
  // Shape bare object ya list ho sakti hai (key scope pe depend) — dono handle
  if (Array.isArray(renderUser)) renderUser = renderUser.length ? renderUser[0] : {};
  const renderEmail = renderUser.email || renderUser.name || "connected";

  await setRenderToken(user.id, token, renderEmail);
  return safeJsonify({ ok: true, render_email: renderEmail });
}
