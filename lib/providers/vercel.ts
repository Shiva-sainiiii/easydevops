/** Vercel API wrapper + project/deployment helpers. */
import { request, sleep, type PyResponse, type RequestOptions } from "@/lib/http";

export function vcApi(
  method: string,
  endpoint: string,
  vcToken: string,
  opts: RequestOptions = {}
): Promise<PyResponse> {
  const url = `https://api.vercel.com${endpoint}`;
  const headers = {
    Authorization: `Bearer ${vcToken}`,
    "Content-Type": "application/json",
    ...(opts.headers || {}),
  };
  return request(method, url, { ...opts, headers, timeout: 20 });
}

/**
 * Saare Vercel projects laata hai, /v9/projects ke `pagination.next` cursor pe
 * loop karke jab tak null na aaye. max_total tak cap.
 * Returns [projects, r].
 */
export async function vercelListAllProjects(
  vcToken: string,
  limit = 100,
  maxTotal = 300
): Promise<[any[], PyResponse | null]> {
  let endpoint: string | null = `/v9/projects?limit=${limit}`;
  const allProjects: any[] = [];
  let r: PyResponse | null = null;
  while (endpoint) {
    r = await vcApi("GET", endpoint, vcToken);
    if (r.status_code !== 200) break;
    const data = r.json();
    allProjects.push(...(data.projects ?? []));
    if (allProjects.length >= maxTotal) break;
    const nextCursor = (data.pagination || {}).next;
    if (!nextCursor) break;
    endpoint = `/v9/projects?limit=${limit}&until=${nextCursor}`;
  }
  return [allProjects.slice(0, maxTotal), r];
}

export async function vercelFindProject(projectName: string, vcToken: string): Promise<any | null> {
  const r = await vcApi("GET", "/v9/projects", vcToken);
  if (r.status_code !== 200) return null;
  for (const p of r.json().projects ?? []) {
    if (p.name === projectName) return p;
  }
  return null;
}

/**
 * GitHub repo se linked Vercel project dhundta hai, project ke naam se
 * independent (repo aur Vercel project alag-alag rename ho sakte hain).
 *
 * Pehle server-side `repo=` filter try karta hai, phir sab projects ka
 * link.repo scan karta hai. Kabhi throw nahi karta — miss pe null.
 */
export async function vercelFindProjectByRepo(repoFullName: string, vcToken: string): Promise<any | null> {
  let r = await vcApi("GET", `/v10/projects?repo=${repoFullName}`, vcToken);
  if (r.status_code === 200) {
    const projects = r.json().projects ?? [];
    if (projects.length === 1) return projects[0];
    if (projects.length > 1) {
      // Ek repo se kai Vercel projects linked (monorepo) — guess nahi karte,
      // "not found" report hoga taaki galat project deploy na ho.
      return null;
    }
  }

  // Fallback: sab projects ka link.repo scan ("owner/name" aur bare "name" dono)
  r = await vcApi("GET", "/v9/projects", vcToken);
  if (r.status_code !== 200) return null;
  const parts = repoFullName.split("/");
  const repoNameOnly = parts[parts.length - 1].toLowerCase();
  for (const p of r.json().projects ?? []) {
    const link = p.link || {};
    if (link.type !== "github") continue;
    const linkedRepo = String(link.repo || "").toLowerCase();
    if (linkedRepo === repoFullName.toLowerCase() || linkedRepo === repoNameOnly) {
      return p;
    }
  }
  return null;
}

/**
 * Project ka asli production URL, latest deployment se — naam se guess nahi.
 * Preference: production alias -> latest deployment ka url -> null
 * (null pe link omit karo, galat link se behtar hai).
 */
export function vercelProjectLiveUrl(project: any): string | null {
  const latest = project.latestDeployments || [];
  if (!latest.length) return null;
  const dep = latest[0];
  const aliases = dep.alias || [];
  if (aliases.length) return `https://${aliases[0]}`;
  if (dep.url) return `https://${dep.url}`;
  return null;
}

export const VERCEL_TERMINAL_STATES = new Set(["READY", "ERROR", "CANCELED"]);

export interface VercelPollResult {
  ok: boolean;
  timed_out: boolean;
  deployment: any;
  state: string;
  live_url: string | null;
}

/**
 * GET /v13/deployments/{id} poll karta hai jab tak terminal readyState ya timeout.
 * Chhota timeout kyunki ye ek hi request ke andar chalta hai.
 */
export async function vercelPollDeployment(
  deploymentId: string,
  vcToken: string,
  maxWaitSeconds = 25,
  intervalSeconds = 3
): Promise<VercelPollResult> {
  let elapsed = 0;
  let lastDep: any = {};
  while (elapsed <= maxWaitSeconds) {
    const r = await vcApi("GET", `/v13/deployments/${deploymentId}`, vcToken);
    if (r.status_code !== 200) {
      await sleep(intervalSeconds * 1000);
      elapsed += intervalSeconds;
      continue;
    }

    const dep = r.json();
    lastDep = dep;
    const state = dep.readyState ?? "UNKNOWN";

    if (VERCEL_TERMINAL_STATES.has(state)) {
      let liveUrl: string | null = null;
      if (state === "READY") {
        const rawUrl = dep.url;
        if (rawUrl) liveUrl = `https://${rawUrl}`;
        if (dep.aliasAssigned && dep.alias) liveUrl = `https://${dep.alias[0]}`;
      }
      return { ok: state === "READY", timed_out: false, deployment: dep, state, live_url: liveUrl };
    }

    await sleep(intervalSeconds * 1000);
    elapsed += intervalSeconds;
  }

  return {
    ok: false,
    timed_out: true,
    deployment: lastDep,
    state: lastDep.readyState ?? "UNKNOWN",
    live_url: null,
  };
}
