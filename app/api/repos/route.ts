import { currentUser } from "@/lib/auth";
import { ghTokenOf } from "@/lib/api-utils";
import { ghListAllRepos } from "@/lib/providers/github";
import { safeJsonify } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Command-form dropdown ke liye repo names
export async function GET() {
  const user = await currentUser();
  if (!user) return safeJsonify({ repos: [] });
  const [repos, r] = await ghListAllRepos(ghTokenOf(user));
  if (r === null || r.status_code !== 200) return safeJsonify({ repos: [] });
  return safeJsonify({ repos: repos.map((rp) => rp["name"]) });
}
