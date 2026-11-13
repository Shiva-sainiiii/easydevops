import { currentUser } from "@/lib/auth";
import { attachment, headerSafe, qs } from "@/lib/api-utils";
import { getUserNetlifyToken, getUserRenderToken, getUserVercelToken } from "@/lib/db";
import { safeJsonify } from "@/lib/security";
import { exportEnvFile } from "@/lib/commands/env_transfer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Env export as .env download. Render: real KEY=value. Vercel/Netlify: sirf "KEY=" scaffold
 * (unki API values return nahi karti) + warning X-Env-Export-Warning header me.
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return safeJsonify({ reply: "❌ Login chahiye.", action: "error" }, 401);

  const platform = qs(req, "platform").toLowerCase();
  const target = qs(req, "target");

  if (!["vercel", "netlify", "render"].includes(platform)) {
    return safeJsonify({ reply: "❌ Platform vercel/netlify/render me se ek honi chahiye.", action: "error" }, 400);
  }
  if (!target) {
    return safeJsonify({ reply: "❌ Project/site/service naam nahi diya.", action: "error" }, 400);
  }

  const result = await exportEnvFile(
    platform,
    target,
    platform === "vercel" ? getUserVercelToken(user) : null,
    platform === "netlify" ? getUserNetlifyToken(user) : null,
    platform === "render" ? getUserRenderToken(user) : null
  );
  if (!Array.isArray(result)) {
    return safeJsonify({ reply: `❌ ${result.error}`, action: "error" }, 400);
  }

  const [filename, text, warning] = result;
  // Warning header me (file body me nahi) taaki downloaded .env clean rahe
  const extra: Record<string, string> = warning ? { "X-Env-Export-Warning": headerSafe(warning) } : {};
  return attachment(text, filename, "text/plain; charset=utf-8", extra);
}
