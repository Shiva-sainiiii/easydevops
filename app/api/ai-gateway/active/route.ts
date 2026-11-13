import { isProvider, validModelId } from "@/lib/ai";
import { getAiKeys, setAiActive } from "@/lib/db";
import { readJsonBody, requireUser } from "@/lib/route-utils";
import { safeJsonify } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Active provider + model set karo (us provider ki kam se kam ek key honi chahiye)
export async function POST(req: Request) {
  const { user, err } = await requireUser();
  if (err) return err;

  const body = await readJsonBody(req);
  const provider = body.provider;
  const model = String(body.model || "").trim();

  if (!isProvider(provider)) return safeJsonify({ reply: "❌ Provider galat hai.", action: "error" }, 400);
  if (!validModelId(model)) return safeJsonify({ reply: "❌ Model ID galat hai.", action: "error" }, 400);

  const keys = await getAiKeys(user.id, provider);
  if (!keys.length) {
    return safeJsonify({ reply: "❌ Is provider ki koi key saved nahi hai. Pehle key add karo.", action: "error" }, 400);
  }

  await setAiActive(user.id, provider, model);
  return safeJsonify({ ok: true });
}
