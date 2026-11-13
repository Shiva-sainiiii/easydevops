import { RequestException, get } from "@/lib/http";
import { readJsonBody, requireUser } from "@/lib/route-utils";
import { safeJsonify } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Token tick/cross pre-validation — kuch save nahi hota, sirf "who am I" call
const first = (j: any): any => (Array.isArray(j) ? (j.length ? j[0] : {}) : j && typeof j === "object" ? j : {});

const VALIDATE_ENDPOINTS: Record<string, [string, (j: any) => any]> = {
  vercel: ["https://api.vercel.com/v2/user", (j) => j.user?.username || j.user?.email],
  netlify: ["https://api.netlify.com/api/v1/user", (j) => j.email || j.full_name],
  render: ["https://api.render.com/v1/users", (j) => first(j).email || first(j).name],
};

export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;

  const { err } = await requireUser();
  if (err) return safeJsonify({ valid: false, reason: "not_logged_in" }, 401);

  if (!Object.prototype.hasOwnProperty.call(VALIDATE_ENDPOINTS, provider)) {
    return safeJsonify({ valid: false, reason: "unknown_provider" }, 400);
  }

  const body = await readJsonBody(req);
  const token = String(body.token || "").trim();
  if (!token) return safeJsonify({ valid: false, reason: "empty" });

  const [url, extractLabel] = VALIDATE_ENDPOINTS[provider];
  let r;
  try {
    r = await get(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeout: 10,
    });
  } catch (e) {
    // Network hiccup "invalid token" nahi hai — frontend ise inconclusive maanta hai
    if (e instanceof RequestException) return safeJsonify({ valid: null, reason: "network_error" });
    throw e;
  }

  if (r.status_code !== 200) return safeJsonify({ valid: false, reason: "rejected" });

  let label: any = null;
  try {
    label = extractLabel(r.json()) ?? null;
  } catch {
    label = null;
  }
  return safeJsonify({ valid: true, label });
}
