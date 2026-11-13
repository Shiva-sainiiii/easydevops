import { AI_PROVIDERS } from "@/lib/ai";
import { getAiSettings, listAiKeys } from "@/lib/db";
import { requireUser } from "@/lib/route-utils";
import { safeJsonify } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// AI Gateway ka poora state: providers, saved keys (sirf last-4 hint), active provider + models
export async function GET() {
  const { user, err } = await requireUser();
  if (err) return err;

  const [keys, st] = await Promise.all([listAiKeys(user.id), getAiSettings(user.id)]);
  return safeJsonify({
    providers: Object.values(AI_PROVIDERS).map((p) => ({
      id: p.id,
      label: p.label,
      key_url: p.key_url,
      key_hint: p.key_hint,
    })),
    keys: keys.map((k) => ({ id: k.id, provider: k.provider, hint: k.key_hint, label: k.label })),
    active_provider: st.active_provider,
    models: st.models,
  });
}
