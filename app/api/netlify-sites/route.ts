import { currentUser } from "@/lib/auth";
import { getUserNetlifyToken } from "@/lib/db";
import { nlListAllSites } from "@/lib/providers/netlify";
import { safeJsonify } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// {site_name} autocomplete
export async function GET() {
  const user = await currentUser();
  if (!user) return safeJsonify({ sites: [] });
  const nlToken = getUserNetlifyToken(user);
  if (!nlToken) return safeJsonify({ sites: [] });
  const [sites, r] = await nlListAllSites(nlToken);
  if (r === null || r.status_code !== 200) return safeJsonify({ sites: [] });
  return safeJsonify({ sites: sites.map((s) => s["name"]) });
}
