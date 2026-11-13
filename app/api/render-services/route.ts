import { currentUser } from "@/lib/auth";
import { getUserRenderToken } from "@/lib/db";
import { rdListAllServices } from "@/lib/providers/render";
import { safeJsonify } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// {service_id} autocomplete — "name (id)" pairs (form submit id nikaal leta hai)
export async function GET() {
  const user = await currentUser();
  if (!user) return safeJsonify({ services: [] });
  const rdToken = getUserRenderToken(user);
  if (!rdToken) return safeJsonify({ services: [] });
  const [entries, r] = await rdListAllServices(rdToken);
  if (r === null || r.status_code !== 200) return safeJsonify({ services: [] });
  // Render list kabhi {"service": {...}} wrap karta hai, kabhi seedha object
  const items: string[] = [];
  for (const entry of entries) {
    const svc = "service" in entry ? entry.service : entry;
    if (svc.name && svc.id) items.push(`${svc.name} (${svc.id})`);
  }
  return safeJsonify({ services: items });
}
