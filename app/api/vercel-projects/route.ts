import { currentUser } from "@/lib/auth";
import { getUserVercelToken } from "@/lib/db";
import { vercelListAllProjects } from "@/lib/providers/vercel";
import { safeJsonify } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// {project_name} datalist. Vercel connected nahi to khaali list (error nahi).
export async function GET() {
  const user = await currentUser();
  if (!user) return safeJsonify({ projects: [] });
  const vcToken = getUserVercelToken(user);
  if (!vcToken) return safeJsonify({ projects: [] });
  const [projects, r] = await vercelListAllProjects(vcToken);
  if (r === null || r.status_code !== 200) return safeJsonify({ projects: [] });
  return safeJsonify({ projects: projects.map((p) => p["name"]) });
}
