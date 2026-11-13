import { currentUser } from "@/lib/auth";
import { qs } from "@/lib/api-utils";
import { getUserVercelToken } from "@/lib/db";
import { vercelFindProjectByRepo } from "@/lib/providers/vercel";
import { safeJsonify } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Post-upload "Deploy vs Import" shortcut ke liye: repo kisi Vercel project se linked hai?
 * Koi bhi not-applicable state (no session / no repo / Vercel not connected) => {linked: false}.
 */
export async function GET(req: Request) {
  const user = await currentUser();
  const repo = qs(req, "repo");
  if (!user || !repo) return safeJsonify({ linked: false });
  const vcToken = getUserVercelToken(user);
  if (!vcToken) return safeJsonify({ linked: false });
  const proj = await vercelFindProjectByRepo(`${user.github_login}/${repo}`, vcToken);
  if (proj) return safeJsonify({ linked: true, project_name: proj.name ?? null });
  return safeJsonify({ linked: false });
}
