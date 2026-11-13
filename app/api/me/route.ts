import { currentUser } from "@/lib/auth";
import { getAiSettings, listAiKeys } from "@/lib/db";
import { safeJsonify } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const has = (b: Buffer | null | undefined) => !!(b && b.length);

export async function GET() {
  const user = await currentUser();
  if (!user) return safeJsonify({ logged_in: false });

  // AI Gateway status — fail ho to login/connect state na bigde
  let aiProvider: string | null = null;
  let aiModel: string | null = null;
  let aiKeyCount = 0;
  let aiConnected = false;
  try {
    const [keys, st] = await Promise.all([listAiKeys(user.id), getAiSettings(user.id)]);
    aiKeyCount = keys.length;
    aiProvider = st.active_provider;
    aiModel = aiProvider ? st.models[aiProvider] ?? null : null;
    aiConnected = !!(aiProvider && aiModel && keys.some((k) => k.provider === aiProvider));
  } catch {
    // ignore
  }

  return safeJsonify({
    logged_in: true,
    login: user.github_login,
    avatar_url: user.avatar_url,
    vercel_connected: has(user.vercel_token_encrypted),
    vercel_username: user.vercel_username,
    netlify_connected: has(user.netlify_token_encrypted),
    netlify_email: user.netlify_email,
    render_connected: has(user.render_token_encrypted),
    render_email: user.render_email,
    ai_connected: aiConnected,
    ai_provider: aiProvider,
    ai_model: aiModel,
    ai_key_count: aiKeyCount,
  });
}
