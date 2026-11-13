/**
 * POST /api/bulk-action — multi-select delete / visibility toggle.
 * Destructive ops do-phase: pehli call confirm_required deti hai (build_confirmation),
 * frontend ka existing Yes/No handler confirmed:true ke saath dobara bhejta hai.
 */
import { currentUser } from "@/lib/auth";
import { ghTokenOf, sstr } from "@/lib/api-utils";
import { getUserNetlifyToken, getUserRenderToken, getUserVercelToken } from "@/lib/db";
import { pyStr } from "@/lib/pyjson";
import { readJsonBody } from "@/lib/route-utils";
import { safeJsonify } from "@/lib/security";
import {
  bulkDeleteFiles,
  bulkDeleteNetlifySites,
  bulkDeleteRenderServices,
  bulkDeleteRepos,
  bulkDeleteVercelProjects,
  bulkSetRepoVisibility,
} from "@/lib/commands/bulk_actions";
import { buildConfirmation, confirmToken } from "@/lib/commands/confirmation";
import { pyTruthy } from "@/lib/commands/pyutil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BULK_CMD_MAP: Record<string, string | null> = {
  delete_files: "BULK_DELETE_FILES",
  delete_repos: "BULK_DELETE_REPOS",
  set_repo_visibility: null, // destructive nahi — confirm nahi chahiye
  delete_vercel_projects: "BULK_DELETE_VERCEL_PROJECTS",
  delete_netlify_sites: "BULK_DELETE_NETLIFY_SITES",
  delete_render_services: "BULK_DELETE_RENDER_SERVICES",
};

const field = (body: Record<string, any>, k: string) => (k in body ? body[k] : []);

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return safeJsonify({ reply: "🔒 Login chahiye.", action: "error" }, 401);
  const ghToken = ghTokenOf(user);
  const owner = user.github_login;

  const body = await readJsonBody(req);
  const op = sstr(body.op);
  if (!Object.prototype.hasOwnProperty.call(BULK_CMD_MAP, op)) {
    return safeJsonify({ reply: "❌ Unknown bulk action.", action: "error" }, 400);
  }

  // ── Confirmed replay (user ne Yes dabaya) ──
  if (body.confirmed) {
    const cmd = body.pending_command;
    const value = body.pending_value;
    const token = body.confirm_token;
    if (token !== confirmToken(pyStr(cmd ?? null), value, user.id)) {
      return safeJsonify({ reply: "❌ Confirmation token match nahi hua. Dobara try kar.", action: "error" });
    }
    let params: Record<string, any> = {};
    try {
      params = value && typeof value === "string" ? JSON.parse(value) : {};
    } catch {
      params = {};
    }
    return safeJsonify(await runBulkOp(op, params, owner, ghToken, user));
  }

  // ── set_repo_visibility reversible hai — turant chalta hai ──
  if (op === "set_repo_visibility") {
    const repos = field(body, "repos");
    const makePrivate = Boolean(body.private);
    if (!pyTruthy(repos)) {
      return safeJsonify({ reply: "Koi repo select nahi kiya gaya.", action: "warning" });
    }
    return safeJsonify(await bulkSetRepoVisibility(repos, makePrivate, owner, ghToken));
  }

  // ── Destructive bulk op ki pehli call — confirm prompt ──
  const cmd = BULK_CMD_MAP[op] as string;
  let params: Record<string, any>;
  if (op === "delete_files") {
    params = { repo: body.repo ?? null, paths: field(body, "paths") };
    if (!pyTruthy(params.repo) || !pyTruthy(params.paths)) {
      return safeJsonify({ reply: "Koi file select nahi ki gayi.", action: "warning" });
    }
  } else if (op === "delete_repos") {
    params = { repos: field(body, "repos") };
    if (!pyTruthy(params.repos)) return safeJsonify({ reply: "Koi repo select nahi kiya gaya.", action: "warning" });
  } else if (op === "delete_vercel_projects") {
    params = { projects: field(body, "projects") };
    if (!pyTruthy(params.projects)) return safeJsonify({ reply: "Koi project select nahi kiya gaya.", action: "warning" });
  } else if (op === "delete_netlify_sites") {
    params = { sites: field(body, "sites") };
    if (!pyTruthy(params.sites)) return safeJsonify({ reply: "Koi site select nahi ki gayi.", action: "warning" });
  } else if (op === "delete_render_services") {
    params = { services: field(body, "services") };
    if (!pyTruthy(params.services)) return safeJsonify({ reply: "Koi service select nahi ki gayi.", action: "warning" });
  } else {
    return safeJsonify({ reply: "❌ Unknown bulk action.", action: "error" }, 400);
  }

  return safeJsonify(buildConfirmation(cmd, params, user.id));
}

async function runBulkOp(
  op: string,
  params: Record<string, any>,
  owner: string,
  ghToken: string,
  user: Parameters<typeof getUserVercelToken>[0]
): Promise<Record<string, any>> {
  const g = (k: string) => (k in params ? params[k] : []);
  if (op === "delete_files") {
    return bulkDeleteFiles(params.repo ?? null, g("paths"), owner, ghToken);
  }
  if (op === "delete_repos") return bulkDeleteRepos(g("repos"), owner, ghToken);
  if (op === "delete_vercel_projects") {
    const vcToken = getUserVercelToken(user);
    if (!vcToken) return { reply: "🔒 Pehle Vercel connect karo.", action: "vercel_auth_required" };
    return bulkDeleteVercelProjects(g("projects"), vcToken);
  }
  if (op === "delete_netlify_sites") {
    const nlToken = getUserNetlifyToken(user);
    if (!nlToken) return { reply: "🔒 Pehle Netlify connect karo.", action: "netlify_auth_required" };
    return bulkDeleteNetlifySites(g("sites"), nlToken);
  }
  if (op === "delete_render_services") {
    const rdToken = getUserRenderToken(user);
    if (!rdToken) return { reply: "🔒 Pehle Render connect karo.", action: "render_auth_required" };
    return bulkDeleteRenderServices(g("services"), rdToken);
  }
  return { reply: "❌ Unknown bulk action.", action: "error" };
}
