import { isProvider, validateKey } from "@/lib/ai";
import { addAiKey, deleteAiKey } from "@/lib/db";
import { readJsonBody, requireUser } from "@/lib/route-utils";
import { safeJsonify } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Key add: save se pehle provider se validate hoti hai
export async function POST(req: Request) {
  const { user, err } = await requireUser();
  if (err) return err;

  const body = await readJsonBody(req);
  const provider = body.provider;
  const key = String(body.key || "").trim();
  const label = String(body.label || "").trim().slice(0, 40) || null;

  if (!isProvider(provider)) return safeJsonify({ reply: "❌ Provider galat hai.", action: "error" }, 400);
  if (!key) return safeJsonify({ reply: "❌ API key khaali hai.", action: "error" }, 400);
  if (key.length > 300 || /\s/.test(key)) {
    return safeJsonify({ reply: "❌ Key sahi format me nahi hai (space/newline hata ke dobara paste karo).", action: "error" }, 400);
  }

  const valid = await validateKey(provider, key);
  if (valid === false) {
    return safeJsonify({ reply: "❌ Ye key valid nahi hai. Provider dashboard se dubara copy karke try karo.", action: "error" }, 400);
  }
  if (valid === null) {
    return safeJsonify({ reply: "❌ Key check nahi ho paayi (network issue). Thodi der baad dobara try karo.", action: "error" }, 502);
  }

  await addAiKey(user.id, provider, key, label);
  return safeJsonify({ ok: true });
}

// Key hatao: DELETE /api/ai-gateway/keys?id=3
export async function DELETE(req: Request) {
  const { user, err } = await requireUser();
  if (err) return err;

  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return safeJsonify({ reply: "❌ Key id galat hai.", action: "error" }, 400);

  await deleteAiKey(user.id, id);
  return safeJsonify({ ok: true });
}
