/**
 * BULK ACTIONS — multi-select operations (bulk_actions.py ka port).
 * Har op partial-failure tolerant hai: ek item fail hone se baaki nahi ruki,
 * reply me per-item breakdown aata hai. Destructive ops confirm-token gate ke peeche
 * (route me) chalti hain.
 */
import { ghApi, getFileSha } from "@/lib/providers/github";
import { vcApi, vercelFindProject } from "@/lib/providers/vercel";
import { nlApi, netlifyFindSite } from "@/lib/providers/netlify";
import { rdApi } from "@/lib/providers/render";
import { safeRepoPath, UnsafePathError } from "@/lib/security";
import { gd, K } from "@/lib/commands/pyutil";
import { pyStr } from "@/lib/pyjson";
import type { PyResponse } from "@/lib/http";

const MAX_BULK_ITEMS = 50; // "select all" galti se 500 API calls na chala de

const cap = <T>(items: T[]): T[] => items.slice(0, MAX_BULK_ITEMS);
const msgOf = (r: PyResponse, dflt: string): string => (r.content.length ? gd(r.json(), "message", dflt) : dflt);
const plural = (n: number) => (n !== 1 ? "s" : "");

type Failed = [string, string][];

export async function bulkDeleteFiles(repo: string, paths: string[], owner: string, ghToken: string) {
  paths = cap(paths);
  const ok: string[] = [];
  const failed: Failed = [];
  for (const rawPath of paths) {
    let path: string;
    try {
      path = safeRepoPath(rawPath);
    } catch (e: any) {
      if (e instanceof UnsafePathError) {
        failed.push([rawPath, "path allowed nahi hai"]);
        continue;
      }
      throw e;
    }
    const sha = await getFileSha(repo, path, owner, ghToken);
    if (!sha) {
      failed.push([path, "exist nahi karti"]);
      continue;
    }
    const r = await ghApi("DELETE", `/repos/${owner}/${repo}/contents/${path}`, ghToken, {
      json: { message: `Bulk delete ${path} via Easy DevOps`, sha },
    });
    if (r.status_code === 200) ok.push(path);
    else failed.push([path, msgOf(r, "delete fail")]);
  }

  return bulkReply(
    "bulk_delete_files",
    ok.length,
    failed.length,
    `${ok.length} file${plural(ok.length)} delete ho gayi` + (ok.length !== 1 ? "n" : ""),
    failed,
    { repo, deleted_paths: ok }
  );
}

export async function bulkDeleteRepos(repoNames: string[], owner: string, ghToken: string) {
  repoNames = cap(repoNames);
  const ok: string[] = [];
  const failed: Failed = [];
  for (const name of repoNames) {
    const r = await ghApi("DELETE", `/repos/${owner}/${name}`, ghToken);
    if (r.status_code === 204) {
      ok.push(name);
    } else {
      let msg = msgOf(r, "delete fail");
      if (r.status_code === 403) msg += " (delete_repo scope chahiye)";
      failed.push([name, msg]);
    }
  }

  return bulkReply(
    "bulk_delete_repos",
    ok.length,
    failed.length,
    ok.length !== 1 ? `${ok.length} repo${plural(ok.length)} delete ho gaye` : "1 repo delete ho gaya",
    failed,
    { deleted_repos: ok }
  );
}

export async function bulkSetRepoVisibility(repoNames: string[], makePrivate: any, owner: string, ghToken: string) {
  repoNames = cap(repoNames);
  const ok: string[] = [];
  const failed: Failed = [];
  for (const name of repoNames) {
    const r = await ghApi("PATCH", `/repos/${owner}/${name}`, ghToken, { json: { private: Boolean(makePrivate) } });
    if (r.status_code === 200) ok.push(name);
    else failed.push([name, msgOf(r, "update fail")]);
  }

  const label = makePrivate ? "private" : "public";
  return bulkReply(
    "bulk_set_repo_visibility",
    ok.length,
    failed.length,
    `${ok.length} repo${plural(ok.length)} ab ${label} hai` + (ok.length !== 1 ? "n" : ""),
    failed,
    { updated_repos: ok, visibility: label }
  );
}

export async function bulkDeleteVercelProjects(projectNames: string[], vcToken: string) {
  projectNames = cap(projectNames);
  const ok: string[] = [];
  const failed: Failed = [];
  for (const name of projectNames) {
    const proj = await vercelFindProject(name, vcToken);
    if (!proj) {
      failed.push([name, "nahi mila"]);
      continue;
    }
    const r = await vcApi("DELETE", `/v9/projects/${pyStr(gd(proj, "id", null))}`, vcToken);
    if (r.status_code === 200 || r.status_code === 204) {
      ok.push(name);
    } else {
      const err = r.text ? gd(gd(r.json(), "error", {}), "message", "delete fail") : "delete fail";
      failed.push([name, err]);
    }
  }

  return bulkReply(
    "bulk_delete_vercel_projects",
    ok.length,
    failed.length,
    ok.length !== 1
      ? `${ok.length} Vercel project${plural(ok.length)} delete ho gaye`
      : "1 Vercel project delete ho gaya",
    failed,
    { deleted_projects: ok }
  );
}

/** Netlify: site name/subdomain -> site object -> site id se delete. */
export async function bulkDeleteNetlifySites(siteNames: string[], nlToken: string) {
  siteNames = cap(siteNames);
  const ok: string[] = [];
  const failed: Failed = [];
  for (const name of siteNames) {
    const site = await netlifyFindSite(name, nlToken);
    if (!site) {
      failed.push([name, "nahi mila"]);
      continue;
    }
    const r = await nlApi("DELETE", `/sites/${K(site, "id")}`, nlToken);
    if (r.status_code === 200 || r.status_code === 204) ok.push(name);
    else failed.push([name, msgOf(r, "delete fail")]);
  }

  return bulkReply(
    "bulk_delete_netlify_sites",
    ok.length,
    failed.length,
    ok.length !== 1
      ? `${ok.length} Netlify site${plural(ok.length)} delete ho gayi`
      : "1 Netlify site delete ho gayi",
    failed,
    { deleted_sites: ok }
  );
}

/** Render: seedha service IDs (srv-xxxxx), name lookup nahi. */
export async function bulkDeleteRenderServices(serviceIds: string[], rdToken: string) {
  serviceIds = cap(serviceIds);
  const ok: string[] = [];
  const failed: Failed = [];
  for (const sid of serviceIds) {
    const r = await rdApi("DELETE", `/services/${sid}`, rdToken);
    if (r.status_code === 200 || r.status_code === 204) ok.push(sid);
    else failed.push([sid, msgOf(r, "delete fail")]);
  }

  return bulkReply(
    "bulk_delete_render_services",
    ok.length,
    failed.length,
    ok.length !== 1
      ? `${ok.length} Render service${plural(ok.length)} delete ho gayi`
      : "1 Render service delete ho gayi",
    failed,
    { deleted_services: ok }
  );
}

function bulkReply(
  action: string,
  okCount: number,
  failCount: number,
  okLabel: string,
  failed: Failed,
  extra: Record<string, any>
): Record<string, any> {
  const lines: string[] = [];
  if (okCount) lines.push(`✅ ${okLabel}.`);
  if (failed.length) {
    lines.push(`⚠️ ${failCount} fail ho gaye:`);
    for (const [name, reason] of failed.slice(0, 15)) {
      // listed failures bhi cap, reply readable rahe
      lines.push(`  • \`${pyStr(name)}\` — ${reason}`);
    }
    if (failed.length > 15) lines.push(`  …aur ${failed.length - 15} aur.`);
  }
  if (!okCount && !failed.length) lines.push("Kuch select nahi kiya gaya.");

  return { reply: lines.join("\n"), action, ok_count: okCount, fail_count: failCount, ...extra };
}
