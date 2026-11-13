import { currentUser } from "@/lib/auth";
import { qs } from "@/lib/api-utils";
import { getUserVercelToken } from "@/lib/db";
import { vcApi, VERCEL_TERMINAL_STATES } from "@/lib/providers/vercel";
import { safeJsonify } from "@/lib/security";
import { gd } from "@/lib/commands/pyutil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Live terminal drawer ke liye polling endpoint (~2.5s). `since` se sirf naye log lines.
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return safeJsonify({ reply: "Session expired.", action: "auth_required" }, 401);

  const vcToken = getUserVercelToken(user);
  if (!vcToken) return safeJsonify({ reply: "Vercel connect nahi hai.", action: "vercel_auth_required" }, 401);

  const deploymentId = qs(req, "deployment_id");
  if (!deploymentId) {
    return safeJsonify({ lines: [], state: "UNKNOWN", done: true, error: "deployment_id required" }, 400);
  }

  const since = new URL(req.url).searchParams.get("since");
  let eventsEndpoint = `/v3/deployments/${deploymentId}/events?direction=forward&limit=300`;
  if (since) eventsEndpoint += `&since=${since}`;

  const evR = await vcApi("GET", eventsEndpoint, vcToken);
  const lines: string[] = [];
  let lastTs = since && /^\d+$/.test(since) ? parseInt(since, 10) : 0;
  if (evR.status_code === 200) {
    for (const event of evR.json()) {
      const text = gd(gd(event, "payload", null) || {}, "text", null);
      const created = gd(event, "created", null) || 0;
      if (text === null || text === undefined) continue;
      for (const row of String(text).split("\n")) {
        if (row.trim()) lines.push(row);
      }
      if (created > lastTs) lastTs = created;
    }
  }

  // Current readyState bhi — frontend ko pata chale kab polling rokni hai
  const depR = await vcApi("GET", `/v13/deployments/${deploymentId}`, vcToken);
  let state = "UNKNOWN";
  let liveUrl: string | null = null;
  let errorMessage: string | null = null;
  if (depR.status_code === 200) {
    const dep = depR.json();
    state = gd(dep, "readyState", "UNKNOWN");
    if (state === "READY") {
      const rawUrl = gd(dep, "url", null);
      if (dep.aliasAssigned && dep.alias) liveUrl = `https://${dep.alias[0]}`;
      else if (rawUrl) liveUrl = `https://${rawUrl}`;
    }
    if (state === "ERROR") errorMessage = dep.errorMessage || "Build failed.";
  }

  return safeJsonify({
    lines,
    since: lastTs,
    state,
    done: VERCEL_TERMINAL_STATES.has(state),
    live_url: liveUrl,
    error_message: errorMessage,
  });
}
