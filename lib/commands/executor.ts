/**
 * execute_command — per-user executor (executor.py ka faithful port).
 *
 * `owner` hamesha logged-in user ka apna GitHub login hota hai — commands request
 * se koi arbitrary owner nahi lete.
 *
 * Python -> TS farq jo yahan handle kiye gaye:
 *  - dict["key"] KeyError  -> req()/K() helpers wahi KeyError-jaisa message dete hain
 *  - dict.get(k, d)        -> gd(obj, k, d) (key present-but-null ko null hi rakhta hai)
 *  - f"{None}" == "None"   -> pyStr()
 *  - requests.Timeout      -> lib/http.ts ka Timeout
 */
import { Timeout } from "@/lib/http";
import { pyStr } from "@/lib/pyjson";
import { KeyErr, req, K, gd, pyOr } from "@/lib/commands/pyutil";
import {
  ghApi,
  getFileSha,
  ghListAllRepos,
  ghGetCheckRuns,
  summarizeCheckRuns,
} from "@/lib/providers/github";
import {
  vcApi,
  vercelFindProject,
  vercelFindProjectByRepo,
  vercelPollDeployment,
  vercelProjectLiveUrl,
  vercelListAllProjects,
} from "@/lib/providers/vercel";
import { nlApi, netlifyFindSite, nlListAllSites } from "@/lib/providers/netlify";
import { rdApi, rdListAllServices } from "@/lib/providers/render";
import { safeRepoPath, UnsafePathError } from "@/lib/security";
import { generateRenderYaml } from "@/lib/commands/render_blueprint";
import { createRenderService } from "@/lib/commands/render_create_service";
import { createPullRequest } from "@/lib/commands/code_generate";

/**
 * BUG-1 (old code): executor.py `time` import karna bhool gaya tha, isliye
 * VERCEL_ROLLBACK (rollback API call ke BAAD) aur VERCEL_LIST_DEPLOYMENTS
 * `time.time()` pe NameError se "❌ Error: name 'time' is not defined" dete the.
 * Faithful port ke liye wahi behavior rakha hai. Fix karne ke liye sirf `true` karo.
 */
const FIX_TIME_BUG = false;
function nowMs(): number {
  if (!FIX_TIME_BUG) throw new Error("name 'time' is not defined");
  return Date.now();
}

const VERCEL_CONNECT = {
  reply: "🔒 Pehle Vercel connect karo — user menu me 'Connect Vercel' dabao.",
  action: "vercel_auth_required",
};
const VERCEL_BAD_TOKEN = {
  reply: "❌ Vercel token invalid ya expire ho gaya. Dubara connect karo.",
  action: "vercel_auth_required",
};
const NETLIFY_CONNECT = {
  reply: "🔒 Pehle Netlify connect karo — user menu me 'Connect Netlify' dabao.",
  action: "netlify_auth_required",
};
const NETLIFY_BAD_TOKEN = {
  reply: "❌ Netlify token invalid ya expire ho gaya. Dubara connect karo.",
  action: "netlify_auth_required",
};
const RENDER_CONNECT = {
  reply: "🔒 Pehle Render connect karo — user menu me 'Connect Render' dabao.",
  action: "render_auth_required",
};
const RENDER_BAD_TOKEN = {
  reply: "❌ Render token invalid ya expire ho gaya. Dubara connect karo.",
  action: "render_auth_required",
};

/** r.json().get("error", {}).get("message", r.text[:200]) */
function apiErrMessage(r: { json(): any; text: string }): string {
  return gd(gd(r.json(), "error", {}), "message", r.text.slice(0, 200));
}

export async function executeCommand(
  cmd: string,
  params: Record<string, any> | null | undefined,
  owner: string,
  ghToken: string,
  vcToken: string | null = null,
  nlToken: string | null = null,
  rdToken: string | null = null
): Promise<Record<string, any>> {
  params = params || {};
  const p = params;

  try {
    if (cmd === "CREATE_REPO") {
      const repoName = String(req(p, "repo")).trim().replace(/[^a-zA-Z0-9_.-]/g, "-");
      const r = await ghApi("POST", "/user/repos", ghToken, {
        json: { name: repoName, private: false, auto_init: true },
      });
      if (r.status_code === 201) {
        const data = r.json();
        return {
          reply: `✅ Repo ban gaya!\n**${repoName}**\n🔗 ${K(data, "html_url")}`,
          action: "create_repo",
          url: data.html_url,
          repo: repoName,
        };
      } else if (r.status_code === 422) {
        return { reply: `⚠️ Repo \`${repoName}\` already exist karta hai.`, action: "warning" };
      } else {
        return { reply: `❌ GitHub Error: ${gd(r.json(), "message", "Repo nahi bana")}`, action: "error" };
      }
    } else if (cmd === "DELETE_REPO") {
      const repoName = String(req(p, "repo")).trim();
      const r = await ghApi("DELETE", `/repos/${owner}/${repoName}`, ghToken);
      if (r.status_code === 204) {
        return { reply: `🗑️ Repo \`${repoName}\` delete ho gaya.`, action: "delete_repo" };
      } else {
        let msg: string = r.content.length ? gd(r.json(), "message", "Repo delete nahi hua") : "Repo delete nahi hua";
        if (r.status_code === 403) {
          msg += " (Hint: OAuth token me `delete_repo` scope chahiye — dubara login/reconnect karke try karo.)";
        }
        return { reply: `❌ Delete Error: ${msg}`, action: "error" };
      }
    } else if (cmd === "LIST_REPOS") {
      const [repos, r] = await ghListAllRepos(ghToken);
      if (r !== null && r.status_code === 200) {
        if (!repos.length) {
          return { reply: "Koi repo nahi hai abhi.", action: "list_repos", repos: [] };
        }
        const lines = repos.map(
          (rp) =>
            `📁 **${K(rp, "name")}** — ⭐${K(rp, "stargazers_count")} — \`${K(rp, "visibility")}\`\n🔗 ${K(rp, "html_url")}`
        );
        // Extra fields sirf frontend ke compact activity-card ke liye; `reply` fallback hai.
        return {
          reply: `Tere ${repos.length} repos:\n\n` + lines.join("\n\n"),
          action: "list_repos",
          repos: repos.map((rp) => ({
            name: rp.name,
            url: rp.html_url,
            stars: gd(rp, "stargazers_count", 0),
            visibility: gd(rp, "visibility", "public"),
            language: gd(rp, "language", null),
            fork: gd(rp, "fork", false),
            updated_at: gd(rp, "updated_at", null),
          })),
        };
      } else {
        return { reply: "❌ Repos fetch nahi hue.", action: "error" };
      }
    } else if (cmd === "LIST_FILES") {
      const repo = req(p, "repo");
      const path = String(gd(p, "path", "")).replace(/^\/+|\/+$/g, "");
      const endpoint = path ? `/repos/${owner}/${repo}/contents/${path}` : `/repos/${owner}/${repo}/contents`;
      const r = await ghApi("GET", endpoint, ghToken);
      if (r.status_code === 200) {
        let items = r.json();
        if (!Array.isArray(items)) items = [items];
        const lines = items.map((item: any) => `${K(item, "type") === "dir" ? "📁" : "📄"} ${K(item, "path")}`);
        const reply = `Files in \`${repo}/${path || ""}\`:\n\n` + lines.join("\n");
        const itemList = items.map((item: any) => ({
          type: K(item, "type"),
          path: K(item, "path"),
          name: K(item, "name"),
        }));
        return { reply, action: "list_files", repo, path, items: itemList };
      } else {
        return { reply: `❌ Files fetch nahi hue: ${gd(r.json(), "message", "")}`, action: "error" };
      }
    } else if (cmd === "READ_FILE") {
      const repo = req(p, "repo");
      const path = req(p, "path");
      const r = await ghApi("GET", `/repos/${owner}/${repo}/contents/${path}`, ghToken);
      if (r.status_code === 200) {
        const fileData = r.json();
        const content = Buffer.from(String(K(fileData, "content")), "base64").toString("utf-8");
        return {
          reply: `📄 \`${path}\` (${K(fileData, "size")} bytes):\n\n\`\`\`\n${content}\n\`\`\``,
          action: "read_file",
          content,
          sha: K(fileData, "sha"),
          repo,
          path,
        };
      } else {
        return { reply: `❌ File nahi mili: ${gd(r.json(), "message", "")}`, action: "error" };
      }
    } else if (cmd === "CREATE_FILE") {
      const repo = req(p, "repo");
      const content: string = req(p, "content");
      let path: string;
      try {
        path = safeRepoPath(req(p, "path"));
      } catch (e: any) {
        if (e instanceof UnsafePathError) return { reply: `❌ Ye path allowed nahi hai: ${e.message}`, action: "error" };
        throw e;
      }
      const message = gd(p, "message", `Add ${path} via Easy DevOps`);
      const contentB64 = Buffer.from(content, "utf-8").toString("base64");
      const existingSha = await getFileSha(repo, path, owner, ghToken);
      const payload: Record<string, any> = { message, content: contentB64 };
      if (existingSha) payload.sha = existingSha;
      const r = await ghApi("PUT", `/repos/${owner}/${repo}/contents/${path}`, ghToken, { json: payload });
      if (r.status_code === 200 || r.status_code === 201) {
        const url = K(K(r.json(), "content"), "html_url");
        const action = existingSha ? "update_file" : "create_file";
        const verb = existingSha ? "Update" : "Bana";
        return { reply: `✅ File ${verb} di!\n**${path}**\n🔗 ${url}`, action, url, repo };
      } else {
        return { reply: `❌ GitHub Error: ${gd(r.json(), "message", "File nahi bani")}`, action: "error" };
      }
    } else if (cmd === "EDIT_FILE") {
      const repo = req(p, "repo");
      const content: string = req(p, "content");
      let path: string;
      try {
        path = safeRepoPath(req(p, "path"));
      } catch (e: any) {
        if (e instanceof UnsafePathError) return { reply: `❌ Ye path allowed nahi hai: ${e.message}`, action: "error" };
        throw e;
      }
      const message = gd(p, "message", `Update ${path} via Easy DevOps`);
      const sha = await getFileSha(repo, path, owner, ghToken);
      if (!sha) {
        return { reply: `❌ File \`${path}\` exist nahi karti repo \`${repo}\` me.`, action: "error" };
      }
      const contentB64 = Buffer.from(content, "utf-8").toString("base64");
      const r = await ghApi("PUT", `/repos/${owner}/${repo}/contents/${path}`, ghToken, {
        json: { message, content: contentB64, sha },
      });
      if (r.status_code === 200 || r.status_code === 201) {
        const url = K(K(r.json(), "content"), "html_url");
        return { reply: `✅ File update ho gayi!\n**${path}**\n🔗 ${url}`, action: "update_file", url, repo };
      } else {
        return { reply: `❌ Update Error: ${gd(r.json(), "message", "")}`, action: "error" };
      }
    } else if (cmd === "DELETE_FILE") {
      const repo = req(p, "repo");
      let path: string;
      try {
        path = safeRepoPath(req(p, "path"));
      } catch (e: any) {
        if (e instanceof UnsafePathError) return { reply: `❌ Ye path allowed nahi hai: ${e.message}`, action: "error" };
        throw e;
      }
      const message = gd(p, "message", `Delete ${path} via Easy DevOps`);
      const sha = await getFileSha(repo, path, owner, ghToken);
      if (!sha) {
        return { reply: `❌ File \`${path}\` exist nahi karti.`, action: "error" };
      }
      const r = await ghApi("DELETE", `/repos/${owner}/${repo}/contents/${path}`, ghToken, {
        json: { message, sha },
      });
      if (r.status_code === 200) {
        return { reply: `🗑️ File \`${path}\` delete ho gayi.`, action: "delete_file" };
      } else {
        return { reply: `❌ Delete Error: ${gd(r.json(), "message", "")}`, action: "error" };
      }
    } else if (cmd === "GENERATE_RENDER_YAML") {
      const repo = req(p, "repo");
      return await generateRenderYaml(repo, owner, ghToken);
    } else if (cmd === "GET_REPO_INFO") {
      const repo = req(p, "repo");
      const r = await ghApi("GET", `/repos/${owner}/${repo}`, ghToken);
      if (r.status_code === 200) {
        const d = r.json();
        let reply =
          `📁 **${K(d, "name")}**\n` +
          `⭐ Stars: ${K(d, "stargazers_count")} | 🍴 Forks: ${K(d, "forks_count")} | ` +
          `👁️ Watchers: ${K(d, "watchers_count")}\n` +
          `🔓 Visibility: \`${K(d, "visibility")}\`\n` +
          `🕓 Last updated: ${pyStr(K(d, "updated_at"))}\n` +
          `🔗 ${K(d, "html_url")}`;
        if (d.description) reply += `\n📝 ${d.description}`;
        // Best-effort CI badge: koi bhi failure swallow, summary None rehti hai.
        let checksSummary: any = null;
        try {
          const defaultBranch = gd(d, "default_branch", null);
          if (defaultBranch) {
            const [checkRuns, checksR] = await ghGetCheckRuns(repo, defaultBranch, owner, ghToken);
            if (checksR !== null && checksR.status_code === 200) {
              checksSummary = summarizeCheckRuns(checkRuns);
            }
          }
        } catch {
          checksSummary = null;
        }
        return {
          reply,
          action: "repo_info",
          repo,
          repo_info: {
            name: d.name,
            url: d.html_url,
            stars: gd(d, "stargazers_count", 0),
            forks: gd(d, "forks_count", 0),
            watchers: gd(d, "watchers_count", 0),
            visibility: gd(d, "visibility", "public"),
            updated_at: gd(d, "updated_at", null),
            description: gd(d, "description", null),
            language: gd(d, "language", null),
            default_branch: gd(d, "default_branch", null),
            checks: checksSummary,
          },
        };
      } else {
        return { reply: `❌ Repo info fetch nahi hui: ${gd(r.json(), "message", "")}`, action: "error" };
      }
    } else if (cmd === "GITHUB_CHECK_STATUS") {
      const repo = req(p, "repo");
      let ref = gd(p, "ref", null);
      if (!ref) {
        // Branch/commit nahi diya — default branch (CREATE_PR jaisa fallback)
        const repoR = await ghApi("GET", `/repos/${owner}/${repo}`, ghToken);
        if (repoR.status_code !== 200) {
          return { reply: `❌ Repo \`${repo}\` nahi mila.`, action: "error" };
        }
        ref = gd(repoR.json(), "default_branch", "main");
      }
      const [checkRuns, r] = await ghGetCheckRuns(repo, ref, owner, ghToken);
      if (r === null || r.status_code !== 200) {
        const err = r !== null ? gd(r.json(), "message", "") : "request failed";
        return { reply: `❌ Check status fetch nahi hua: ${err}`, action: "error" };
      }
      const summary = summarizeCheckRuns(checkRuns);
      let reply: string;
      if (summary.state === "none") {
        reply = `ℹ️ \`${repo}\` (${ref}) par koi GitHub Actions check-run nahi mila.`;
      } else {
        const icon = ({ success: "✅", failure: "❌", pending: "🟡" } as Record<string, string>)[summary.state];
        reply =
          `${icon} \`${repo}\` (${ref}): ${summary.passed} passed, ` +
          `${summary.failed} failed, ${summary.pending} pending ` +
          `— ${summary.total} check(s) total`;
        for (const c of summary.checks) {
          const cIcon =
            ({ success: "✅", failure: "❌", pending: "🟡", skipped: "⏭️" } as Record<string, string>)[c.state] ?? "•";
          reply += `\n${cIcon} ${pyStr(c.name)}`;
        }
      }
      return { reply, action: "check_status", repo, ref, checks_summary: summary };
    } else if (cmd === "CREATE_PR") {
      const repo = req(p, "repo");
      const head = req(p, "head");
      let base = gd(p, "base", null);
      if (!base) {
        const repoR = await ghApi("GET", `/repos/${owner}/${repo}`, ghToken);
        if (repoR.status_code !== 200) {
          return { reply: `❌ Repo \`${repo}\` nahi mila.`, action: "error" };
        }
        base = gd(repoR.json(), "default_branch", "main");
      }
      if (head === base) {
        return {
          reply: `❌ Head aur base branch same hai (\`${head}\`) — PR ke liye alag branches chahiye.`,
          action: "error",
        };
      }
      const title = `Merge ${head} into ${base}`;
      const [ok, errOrEmpty, prUrl] = await createPullRequest(owner, repo, ghToken, head, base, title);
      if (ok) {
        return {
          reply: `✅ PR khul gaya: \`${head}\` → \`${base}\`\n🔀 ${pyStr(prUrl)}`,
          action: "pr_created",
          repo,
          head,
          base,
          pr_url: prUrl,
        };
      } else {
        return { reply: `❌ PR create nahi hua: ${errOrEmpty}`, action: "error" };
      }
    }

    // ──────────────── VERCEL ────────────────
    // Har branch pehle vcToken check karta hai: missing ho to "connect Vercel" prompt.
    else if (cmd === "VERCEL_LIST_PROJECTS") {
      if (!vcToken) return { ...VERCEL_CONNECT };
      const [projects, r] = await vercelListAllProjects(vcToken);
      if (r !== null && r.status_code === 200) {
        if (!projects.length) {
          return { reply: "Koi Vercel project nahi mila.", action: "vercel_list", projects: [] };
        }
        const vercelStatus = (pr: any) => {
          const latest = gd(pr, "latestDeployments", null) || [];
          return (latest.length ? gd(latest[0], "readyState", null) : null) || "UNKNOWN";
        };
        const lines: string[] = [];
        const projectCards: any[] = [];
        for (const pr of projects) {
          // Real URL latest deployment se — naam se guess nahi (vercelProjectLiveUrl)
          const live = vercelProjectLiveUrl(pr);
          const linkLine = live ? `\n🔗 ${live}` : "\n_(abhi koi deployment nahi — link uplabdh nahi)_";
          lines.push(`▲ **${K(pr, "name")}** — \`${pyOr(gd(pr, "framework", null), "static")}\`${linkLine}`);
          projectCards.push({
            name: pr.name,
            id: K(pr, "id"),
            framework: gd(pr, "framework", null),
            url: live,
            status: vercelStatus(pr),
          });
        }
        return {
          reply: `Tere ${projects.length} Vercel projects:\n\n` + lines.join("\n\n"),
          action: "vercel_list",
          projects: projectCards,
        };
      } else if (r !== null && (r.status_code === 401 || r.status_code === 403)) {
        return { ...VERCEL_BAD_TOKEN };
      } else {
        return {
          reply: `❌ Vercel projects fetch nahi hue: ${r !== null ? r.text.slice(0, 200) : "connection error"}`,
          action: "error",
        };
      }
    } else if (cmd === "VERCEL_IMPORT_REPO") {
      if (!vcToken) return { ...VERCEL_CONNECT };
      const repo = req(p, "repo");
      const projectName = gd(p, "project_name", null) || repo;
      const payload = {
        name: projectName,
        gitRepository: { type: "github", repo: `${owner}/${repo}` },
      };
      const r = await vcApi("POST", "/v11/projects", vcToken, { json: payload });
      if (r.status_code === 200 || r.status_code === 201) {
        const proj = r.json();
        const latest = gd(proj, "latestDeployments", null) || [];
        const depId = latest.length ? gd(latest[0], "uid", null) || gd(latest[0], "id", null) : null;
        let reply =
          `✅ \`${repo}\` Vercel se connect ho gaya!\n**Project: ${K(proj, "name")}**\n` +
          `Project ID: \`${pyStr(gd(proj, "id", null))}\`\n\n`;
        if (depId) {
          reply +=
            `⏳ Vercel ne automatically ek initial build queue kar diya hai (Deployment ID: \`${depId}\`).\n` +
            `Status check karne ke liye bol: 'check deployment status ${depId}'.`;
        } else {
          reply += `Build abhi queue nahi hua. Deploy trigger karne ke liye bol: 'deploy ${proj.name} to vercel'.`;
        }
        return { reply, action: "vercel_import", project_name: proj.name, project_id: gd(proj, "id", null) };
      } else if (r.status_code === 401 || r.status_code === 403) {
        return { ...VERCEL_BAD_TOKEN };
      } else {
        return { reply: `❌ Vercel import Error: ${apiErrMessage(r)}`, action: "error" };
      }
    } else if (cmd === "VERCEL_DEPLOY") {
      if (!vcToken) return { ...VERCEL_CONNECT };
      const projectName = req(p, "project_name");
      let proj = await vercelFindProject(projectName, vcToken);
      let resolvedByRepo = false;
      if (!proj) {
        // Naam Vercel project se match nahi hua — aksar ye GitHub repo ka naam hota hai.
        proj = await vercelFindProjectByRepo(`${owner}/${projectName}`, vcToken);
        resolvedByRepo = !!proj;
      }
      if (!proj) {
        return {
          reply: `❌ Vercel project \`${projectName}\` nahi mila (naam se ya linked GitHub repo se). Pehle import kar, ya sahi Vercel project naam bata.`,
          action: "error",
        };
      }
      const actualProjectName = gd(proj, "name", projectName);

      const gitRepo = gd(proj, "link", {});
      const repoId = gd(gitRepo, "repoId", null);
      const gitBranch = gd(gitRepo, "productionBranch", "main");
      if (!repoId) {
        return { reply: `❌ Project \`${actualProjectName}\` GitHub se linked nahi hai. Pehle import kar.`, action: "error" };
      }

      const payload = {
        name: actualProjectName,
        target: "production",
        gitSource: { type: "github", repoId, ref: gitBranch },
        projectSettings: { framework: gd(proj, "framework", null) },
      };
      const r = await vcApi("POST", "/v13/deployments", vcToken, { json: payload });
      if (r.status_code !== 200 && r.status_code !== 201) {
        if (r.status_code === 401 || r.status_code === 403) return { ...VERCEL_BAD_TOKEN };
        return { reply: `❌ Vercel deploy trigger Error: ${apiErrMessage(r)}`, action: "error" };
      }

      const dep = r.json();
      const depId = gd(dep, "id", null);
      if (!depId) {
        return { reply: "❌ Vercel ne deployment ID nahi diya, kuch galat hua.", action: "error" };
      }

      const nameNote =
        resolvedByRepo && actualProjectName !== projectName
          ? ` (repo \`${projectName}\` → Vercel project \`${actualProjectName}\`)`
          : "";
      const result = await vercelPollDeployment(depId, vcToken);
      if (result.ok) {
        return {
          reply: `✅ Deployment complete!${nameNote}\n**${actualProjectName}**\n🔗 ${pyStr(result.live_url)}\n\nID: \`${depId}\``,
          action: "vercel_deploy",
          deployment_id: depId,
          url: result.live_url,
          project_name: actualProjectName,
        };
      } else if (result.timed_out) {
        return {
          reply:
            `⏳ Deploy trigger ho gaya hai${nameNote} (ID: \`${depId}\`), lekin build abhi bhi chal raha hai.\n\n` +
            `Status check karne ke liye thodi der baad bol: 'check deployment status ${depId}'.`,
          action: "vercel_deploy_pending",
          deployment_id: depId,
          project_name: actualProjectName,
        };
      } else {
        const errorDetail = gd(result.deployment, "errorMessage", "") || result.state;
        return {
          reply: `❌ Deployment fail ho gaya.${nameNote}\nStatus: **${result.state}**\n${errorDetail}\nID: \`${depId}\``,
          action: "error",
          deployment_id: depId,
        };
      }
    } else if (cmd === "VERCEL_DELETE_PROJECT") {
      if (!vcToken) return { ...VERCEL_CONNECT };
      const projectName = req(p, "project_name");
      const proj = await vercelFindProject(projectName, vcToken);
      if (!proj) {
        return { reply: `❌ Vercel project \`${projectName}\` nahi mila.`, action: "error" };
      }
      const r = await vcApi("DELETE", `/v9/projects/${pyStr(gd(proj, "id", null))}`, vcToken);
      if (r.status_code === 200 || r.status_code === 204) {
        return {
          reply: `✅ Vercel project \`${projectName}\` delete ho gaya.\n\n⚠️ GitHub repo abhi bhi waisa hi hai.`,
          action: "vercel_delete_project",
          project_name: projectName,
        };
      } else if (r.status_code === 401 || r.status_code === 403) {
        return { ...VERCEL_BAD_TOKEN };
      } else {
        const err = r.text ? apiErrMessage(r) : r.text.slice(0, 200);
        return { reply: `❌ Vercel project delete Error: ${err}`, action: "error" };
      }
    } else if (cmd === "VERCEL_ROLLBACK") {
      // Instant Rollback: production traffic ko purani READY deployment pe repoint karta hai.
      if (!vcToken) return { ...VERCEL_CONNECT };
      const projectName = req(p, "project_name");
      const proj = await vercelFindProject(projectName, vcToken);
      if (!proj) {
        return { reply: `❌ Vercel project \`${projectName}\` nahi mila.`, action: "error" };
      }
      const projectId = gd(proj, "id", null);

      let targetId = gd(p, "deployment_id", null);
      let targetDep: any = null;
      if (!targetId) {
        const r0 = await vcApi("GET", `/v6/deployments?projectId=${pyStr(projectId)}&target=production&limit=10`, vcToken);
        if (r0.status_code !== 200) {
          if (r0.status_code === 401 || r0.status_code === 403) return { ...VERCEL_BAD_TOKEN };
          return { reply: `❌ Deployments list nahi mili: ${r0.text.slice(0, 200)}`, action: "error" };
        }
        const deployments: any[] = gd(r0.json(), "deployments", []);
        const ready = deployments.filter((d) => gd(d, "state", null) === "READY");
        if (ready.length < 2) {
          return {
            reply: `❌ \`${projectName}\` ke paas rollback ke liye purani READY deployment nahi hai.`,
            action: "error",
          };
        }
        // index 0 = current live, index 1 = previous production deploy
        targetDep = ready[1];
        targetId = gd(targetDep, "uid", null) || gd(targetDep, "id", null);
      }

      const r = await vcApi("POST", `/v1/projects/${pyStr(projectId)}/rollback/${targetId}`, vcToken, { json: {} });
      if (r.status_code !== 200 && r.status_code !== 201 && r.status_code !== 204) {
        if (r.status_code === 401 || r.status_code === 403) return { ...VERCEL_BAD_TOKEN };
        const err = r.text ? apiErrMessage(r) : "Rollback fail ho gaya";
        return { reply: `❌ Rollback Error: ${err}`, action: "error" };
      }

      const created = targetDep ? gd(targetDep, "created", null) : null;
      let whenDesc = "";
      if (created) {
        const ageMin = Math.trunc((nowMs() - created) / 60000); // BUG-1: FIX_TIME_BUG dekho
        whenDesc = ageMin < 120 ? ` (~${ageMin} min pehle ki deployment)` : "";
      }
      return {
        reply:
          `⏪ \`${projectName}\` rollback ho gaya${whenDesc}!\nDeployment \`${targetId}\` ab live traffic serve kar rahi hai.\n\n` +
          `Naye pushes production pe apne aap deploy nahi honge jab tak 'undo rollback' na karo (promote a new deployment).`,
        action: "vercel_rollback",
        project_name: projectName,
        deployment_id: targetId,
      };
    } else if (cmd === "VERCEL_LIST_DEPLOYMENTS") {
      // Recent production deployments + state + age, taaki user rollback ke liye chun sake.
      if (!vcToken) return { ...VERCEL_CONNECT };
      const projectName = req(p, "project_name");
      const proj = await vercelFindProject(projectName, vcToken);
      if (!proj) {
        return { reply: `❌ Vercel project \`${projectName}\` nahi mila.`, action: "error" };
      }
      const r = await vcApi(
        "GET",
        `/v6/deployments?projectId=${pyStr(gd(proj, "id", null))}&target=production&limit=10`,
        vcToken
      );
      if (r.status_code !== 200) {
        if (r.status_code === 401 || r.status_code === 403) return { ...VERCEL_BAD_TOKEN };
        return { reply: `❌ Deployments list nahi mili: ${r.text.slice(0, 200)}`, action: "error" };
      }
      const deployments: any[] = gd(r.json(), "deployments", []);
      if (!deployments.length) {
        return {
          reply: `\`${projectName}\` ki koi production deployment nahi mili.`,
          action: "vercel_deployments",
          deployments: [],
        };
      }
      const lines: string[] = [];
      const depList: any[] = [];
      for (const d of deployments.slice(0, 10)) {
        const depId = gd(d, "uid", null) || gd(d, "id", null);
        const state = gd(d, "state", "UNKNOWN");
        const created = gd(d, "created", null);
        const ageMin = created ? Math.trunc((nowMs() - created) / 60000) : null; // BUG-1
        const ageDesc =
          ageMin !== null && ageMin < 120 ? `${ageMin}m pehle` : ageMin ? `${Math.floor(ageMin / 60)}h pehle` : "";
        const icon = state === "READY" ? "🟢" : state === "ERROR" ? "🔴" : "⚪";
        lines.push(`${icon} \`${pyStr(depId)}\` — ${state} — ${ageDesc}`);
        depList.push({ id: depId, state, age_min: ageMin });
      }
      return {
        reply:
          `\`${projectName}\` ki recent deployments:\n\n` +
          lines.join("\n") +
          "\n\nRollback karne ke liye bol: 'rollback " +
          projectName +
          " to <id>'",
        action: "vercel_deployments",
        project_name: projectName,
        deployments: depList,
      };
    } else if (cmd === "VERCEL_GET_ENV") {
      if (!vcToken) return { ...VERCEL_CONNECT };
      const projectName = req(p, "project_name");
      const proj = await vercelFindProject(projectName, vcToken);
      if (!proj) {
        return { reply: `❌ Vercel project \`${projectName}\` nahi mila.`, action: "error" };
      }
      const r = await vcApi("GET", `/v9/projects/${pyStr(gd(proj, "id", null))}/env`, vcToken);
      if (r.status_code === 200) {
        const envs: any[] = gd(r.json(), "envs", []);
        if (!envs.length) {
          return { reply: `Project \`${projectName}\` me koi env vars nahi hai.`, action: "vercel_env", env_vars: [] };
        }
        const lines = envs.map((e) => `\`${K(e, "key")}\` — targets: ${gd(e, "target", []).join(", ")}`);
        return {
          reply: `Env vars for \`${projectName}\` (values encrypted, sirf keys dikha sakta hu):\n\n` + lines.join("\n"),
          action: "vercel_env",
          project_name: projectName,
          env_vars: envs.map((e) => ({ key: e.key, target: gd(e, "target", []) })),
        };
      } else if (r.status_code === 401 || r.status_code === 403) {
        return { ...VERCEL_BAD_TOKEN };
      } else {
        return { reply: `❌ Env vars fetch nahi hue: ${r.text.slice(0, 200)}`, action: "error" };
      }
    } else if (cmd === "VERCEL_SET_ENV") {
      if (!vcToken) return { ...VERCEL_CONNECT };
      const projectName = req(p, "project_name");
      const key = req(p, "key");
      const value = req(p, "value");
      const target = gd(p, "target", ["production", "preview", "development"]);
      const proj = await vercelFindProject(projectName, vcToken);
      if (!proj) {
        return { reply: `❌ Vercel project \`${projectName}\` nahi mila.`, action: "error" };
      }
      const r = await vcApi("POST", `/v10/projects/${pyStr(gd(proj, "id", null))}/env`, vcToken, {
        json: { key, value, type: "encrypted", target },
      });
      if (r.status_code === 200 || r.status_code === 201) {
        return {
          reply: `✅ Env var \`${key}\` set ho gaya \`${projectName}\` me.\n⚠️ Naya deploy trigger karo change apply karne ke liye.`,
          action: "vercel_env_set",
          project_name: projectName,
        };
      } else if (r.status_code === 401 || r.status_code === 403) {
        return { ...VERCEL_BAD_TOKEN };
      } else {
        return { reply: `❌ Env set Error: ${apiErrMessage(r)}`, action: "error" };
      }
    }

    // ──────────────── NETLIFY ────────────────
    else if (cmd === "NETLIFY_DEPLOY") {
      // POST /sites/{id}/builds — seedha production build trigger, status polling nahi.
      if (!nlToken) return { ...NETLIFY_CONNECT };
      const siteName = req(p, "site_name");
      const site = await netlifyFindSite(siteName, nlToken);
      if (!site) {
        return { reply: `❌ Netlify site \`${siteName}\` nahi mili.`, action: "error" };
      }
      const r = await nlApi("POST", `/sites/${K(site, "id")}/builds`, nlToken, { json: {} });
      if (r.status_code === 200 || r.status_code === 201) {
        const build = r.json();
        return {
          reply: `✅ Deploy trigger ho gaya \`${siteName}\` ke liye!\nBuild ID: \`${pyStr(gd(build, "id", ""))}\`\n\n🔗 ${pyStr(gd(site, "url", ""))}\n\nBuild Netlify dashboard pe track ho sakti hai.`,
          action: "netlify_deploy",
          site_name: siteName,
          build_id: gd(build, "id", null),
        };
      } else if (r.status_code === 401 || r.status_code === 403) {
        return { ...NETLIFY_BAD_TOKEN };
      } else {
        return { reply: `❌ Netlify deploy trigger Error: ${r.text.slice(0, 200)}`, action: "error" };
      }
    } else if (cmd === "NETLIFY_LIST_SITES") {
      if (!nlToken) return { ...NETLIFY_CONNECT };
      const [sites, r] = await nlListAllSites(nlToken);
      if (r !== null && r.status_code === 200) {
        if (!sites.length) {
          return { reply: "Koi Netlify site nahi mili.", action: "netlify_list", sites: [] };
        }
        const lines = sites.map((s) => `🌐 **${K(s, "name")}**\n🔗 ${pyStr(gd(s, "url", ""))}`);
        return {
          reply: `Teri ${sites.length} Netlify sites:\n\n` + lines.join("\n\n"),
          action: "netlify_list",
          sites: sites.map((s) => ({
            name: s.name,
            id: K(s, "id"),
            url: gd(s, "url", ""),
            status: gd(s, "state", "unknown"),
          })),
        };
      } else if (r !== null && (r.status_code === 401 || r.status_code === 403)) {
        return { ...NETLIFY_BAD_TOKEN };
      } else {
        return {
          reply: `❌ Netlify sites fetch nahi hui: ${r !== null ? r.text.slice(0, 200) : "connection error"}`,
          action: "error",
        };
      }
    } else if (cmd === "NETLIFY_GET_SITE_INFO") {
      if (!nlToken) return { ...NETLIFY_CONNECT };
      const siteName = req(p, "site_name");
      const site = await netlifyFindSite(siteName, nlToken);
      if (!site) {
        return { reply: `❌ Netlify site \`${siteName}\` nahi mili.`, action: "error" };
      }
      let reply =
        `🌐 **${K(site, "name")}**\n` +
        `🔗 ${pyStr(gd(site, "url", ""))}\n` +
        `🆔 \`${K(site, "id")}\`\n` +
        `🕓 Last updated: ${pyStr(gd(site, "updated_at", ""))}`;
      if (site.custom_domain) reply += `\n🌍 Custom domain: ${site.custom_domain}`;
      return {
        reply,
        action: "netlify_site_info",
        site_name: siteName,
        site_info: {
          name: site.name,
          id: site.id,
          url: gd(site, "url", ""),
          updated_at: gd(site, "updated_at", null),
          custom_domain: gd(site, "custom_domain", null),
          state: gd(site, "state", "unknown"),
        },
      };
    } else if (cmd === "NETLIFY_DELETE_SITE") {
      if (!nlToken) return { ...NETLIFY_CONNECT };
      const siteName = req(p, "site_name");
      const site = await netlifyFindSite(siteName, nlToken);
      if (!site) {
        return { reply: `❌ Netlify site \`${siteName}\` nahi mili.`, action: "error" };
      }
      const r = await nlApi("DELETE", `/sites/${K(site, "id")}`, nlToken);
      if (r.status_code === 200 || r.status_code === 204) {
        return { reply: `🗑️ Netlify site \`${siteName}\` delete ho gayi.`, action: "netlify_delete_site" };
      } else if (r.status_code === 401 || r.status_code === 403) {
        return { ...NETLIFY_BAD_TOKEN };
      } else {
        return { reply: `❌ Site delete Error: ${r.text.slice(0, 200)}`, action: "error" };
      }
    } else if (cmd === "NETLIFY_GET_ENV") {
      if (!nlToken) return { ...NETLIFY_CONNECT };
      const siteName = req(p, "site_name");
      const site = await netlifyFindSite(siteName, nlToken);
      if (!site) {
        return { reply: `❌ Netlify site \`${siteName}\` nahi mili.`, action: "error" };
      }
      const accountId = gd(site, "account_id", null);
      if (!accountId) {
        return { reply: "❌ Is site ka account_id nahi mila.", action: "error" };
      }
      const r = await nlApi("GET", `/accounts/${accountId}/env?site_id=${K(site, "id")}`, nlToken);
      if (r.status_code === 200) {
        const envs: any[] = r.json();
        if (!envs || !envs.length) {
          return { reply: `Site \`${siteName}\` me koi env vars nahi hai.`, action: "netlify_env", env_vars: [] };
        }
        const lines = envs.map((e) => `\`${K(e, "key")}\``);
        return {
          reply: `Env vars for \`${siteName}\` (values encrypted, sirf keys dikha sakta hu):\n\n` + lines.join("\n"),
          action: "netlify_env",
          site_name: siteName,
          env_vars: envs.map((e) => ({ key: e.key })),
        };
      } else if (r.status_code === 401 || r.status_code === 403) {
        return { ...NETLIFY_BAD_TOKEN };
      } else {
        return { reply: `❌ Env vars fetch nahi hue: ${r.text.slice(0, 200)}`, action: "error" };
      }
    } else if (cmd === "NETLIFY_SET_ENV") {
      if (!nlToken) return { ...NETLIFY_CONNECT };
      const siteName = req(p, "site_name");
      const key = req(p, "key");
      const value = req(p, "value");
      const site = await netlifyFindSite(siteName, nlToken);
      if (!site) {
        return { reply: `❌ Netlify site \`${siteName}\` nahi mili.`, action: "error" };
      }
      const accountId = gd(site, "account_id", null);
      if (!accountId) {
        return { reply: "❌ Is site ka account_id nahi mila.", action: "error" };
      }
      const payload = {
        key,
        scopes: ["builds", "functions", "runtime", "post_processing"],
        values: [{ value, context: "all" }],
      };
      const r = await nlApi("POST", `/accounts/${accountId}/env?site_id=${K(site, "id")}`, nlToken, { json: payload });
      if (r.status_code === 200 || r.status_code === 201) {
        return {
          reply: `✅ Env var \`${key}\` set ho gaya \`${siteName}\` me.\n⚠️ Naya deploy trigger karo change apply karne ke liye.`,
          action: "netlify_env_set",
          site_name: siteName,
        };
      } else if (r.status_code === 401 || r.status_code === 403) {
        return { ...NETLIFY_BAD_TOKEN };
      } else {
        return { reply: `❌ Env set Error: ${r.text.slice(0, 200)}`, action: "error" };
      }
    }

    // ──────────────── RENDER ────────────────
    else if (cmd === "RENDER_CREATE_SERVICE") {
      if (!rdToken) return { ...RENDER_CONNECT };
      const repo = req(p, "repo");
      const plan = gd(p, "plan", null);
      const branch = gd(p, "branch", null);
      const region = gd(p, "region", null);
      return await createRenderService(repo, owner, ghToken, rdToken, plan, branch, region);
    } else if (cmd === "RENDER_LIST_SERVICES") {
      if (!rdToken) return { ...RENDER_CONNECT };
      const [items, r] = await rdListAllServices(rdToken);
      if (r !== null && r.status_code === 200) {
        if (!items.length) {
          return { reply: "Koi Render service nahi mila.", action: "render_list", services: [] };
        }
        const lines: string[] = [];
        const services: any[] = [];
        const icons: Record<string, string> = {
          web_service: "🌐",
          static_site: "📦",
          private_service: "🔒",
          background_worker: "⚙️",
          cron_job: "⏰",
          postgres: "🐘",
          redis: "🟥",
        };
        for (const item of items) {
          const svc = gd(item, "service", item);
          const name = gd(svc, "name", "unknown");
          const stype = gd(svc, "type", "service");
          const sid = gd(svc, "id", "");
          const url = gd(gd(svc, "serviceDetails", {}), "url", "");
          // "suspended" hi ek reliable top-level signal hai (deploy status alag call hai)
          const suspended = gd(svc, "suspended", null) === "suspended";
          const icon = icons[stype] ?? "🧩";
          let line = `${icon} **${pyStr(name)}** — \`${pyStr(stype)}\`\nID: \`${pyStr(sid)}\``;
          if (url) line += `\n🔗 ${url}`;
          lines.push(line);
          services.push({ name, id: sid, type: stype, url, status: suspended ? "suspended" : "active" });
        }
        return {
          reply: `Tere ${items.length} Render services:\n\n` + lines.join("\n\n"),
          action: "render_list",
          services,
        };
      } else if (r !== null && (r.status_code === 401 || r.status_code === 403)) {
        return { ...RENDER_BAD_TOKEN };
      } else {
        return {
          reply: `❌ Render services fetch nahi hue: ${r !== null ? r.text.slice(0, 200) : "connection error"}`,
          action: "error",
        };
      }
    } else if (cmd === "RENDER_GET_ENV") {
      if (!rdToken) return { ...RENDER_CONNECT };
      const serviceId = req(p, "service_id");
      const r = await rdApi("GET", `/services/${serviceId}/env-vars?limit=100`, rdToken);
      if (r.status_code === 200) {
        const items: any[] = r.json();
        if (!items || !items.length) {
          return { reply: `Service \`${serviceId}\` me koi env vars nahi hai.`, action: "render_env", env_vars: [] };
        }
        const lines = items.map((item) => `\`${K(K(item, "envVar"), "key")}\` = \`${K(K(item, "envVar"), "value")}\``);
        return {
          reply: `Env vars for \`${serviceId}\`:\n\n` + lines.join("\n"),
          action: "render_env",
          service_id: serviceId,
          env_vars: items.map((item) => ({ key: item.envVar.key, value: item.envVar.value })),
        };
      } else if (r.status_code === 401 || r.status_code === 403) {
        return { ...RENDER_BAD_TOKEN };
      } else {
        return { reply: `❌ Env vars fetch nahi hue: ${r.text.slice(0, 200)}`, action: "error" };
      }
    } else if (cmd === "RENDER_SET_ENV") {
      if (!rdToken) return { ...RENDER_CONNECT };
      const serviceId = req(p, "service_id");
      const newVars: Record<string, any> = req(p, "env_vars");

      const existingR = await rdApi("GET", `/services/${serviceId}/env-vars?limit=100`, rdToken);
      const existing = new Map<string, any>();
      if (existingR.status_code === 200) {
        for (const item of existingR.json()) {
          existing.set(K(K(item, "envVar"), "key"), item.envVar.value);
        }
      } else if (existingR.status_code === 401 || existingR.status_code === 403) {
        return { ...RENDER_BAD_TOKEN };
      }

      for (const [k, v] of Object.entries(newVars)) existing.set(k, v);
      const payload = Array.from(existing.entries()).map(([k, v]) => ({ key: k, value: v }));

      const r = await rdApi("PUT", `/services/${serviceId}/env-vars`, rdToken, { json: payload });
      if (r.status_code === 200 || r.status_code === 201) {
        const keys = Object.keys(newVars).join(", ");
        return {
          reply: `✅ Env vars update ho gaye for \`${serviceId}\`!\nUpdated keys: \`${keys}\`\n\n⚠️ Service redeploy hoga automatically Render ki taraf se.`,
          action: "render_env_update",
          service_id: serviceId,
        };
      } else if (r.status_code === 401 || r.status_code === 403) {
        return { ...RENDER_BAD_TOKEN };
      } else {
        return { reply: `❌ Env update Error: ${r.text.slice(0, 200)}`, action: "error" };
      }
    } else if (cmd === "RENDER_DEPLOY") {
      if (!rdToken) return { ...RENDER_CONNECT };
      const serviceId = req(p, "service_id");
      const clearCache = gd(p, "clear_cache", false);
      const payload = { clearCache: clearCache ? "clear" : "do_not_clear" };
      const r = await rdApi("POST", `/services/${serviceId}/deploys`, rdToken, { json: payload });
      if (r.status_code === 200 || r.status_code === 201) {
        const dep = r.json();
        const depId = gd(dep, "id", "");
        const status = gd(dep, "status", "queued");
        const cacheNote = clearCache ? "(cache cleared)" : "";
        return {
          reply: `🚀 Deploy trigger ho gaya for \`${serviceId}\` ${cacheNote}\nDeploy ID: \`${pyStr(depId)}\`\nStatus: **${pyStr(status)}**`,
          action: "render_deploy",
          deploy_id: depId,
          status,
        };
      } else if (r.status_code === 401 || r.status_code === 403) {
        return { ...RENDER_BAD_TOKEN };
      } else {
        return { reply: `❌ Render deploy Error: ${r.text.slice(0, 200)}`, action: "error" };
      }
    } else if (cmd === "RENDER_DELETE_SERVICE") {
      if (!rdToken) return { ...RENDER_CONNECT };
      const serviceId = req(p, "service_id");
      const r = await rdApi("DELETE", `/services/${serviceId}`, rdToken);
      if (r.status_code === 200 || r.status_code === 204) {
        return { reply: `🗑️ Render service \`${serviceId}\` delete ho gaya.`, action: "render_delete_service" };
      } else if (r.status_code === 401 || r.status_code === 403) {
        return { ...RENDER_BAD_TOKEN };
      } else {
        return { reply: `❌ Service delete Error: ${r.text.slice(0, 200)}`, action: "error" };
      }
    } else {
      return { reply: `❌ Unknown command: ${cmd}`, action: "error" };
    }
  } catch (e: any) {
    if (e instanceof KeyErr) {
      return {
        reply: `❌ Required field missing: ${e.message}. Dobara try kar zyada detail ke saath.`,
        action: "error",
      };
    }
    if (e instanceof Timeout) {
      return { reply: "❌ Request timeout ho gaya. Dobara try karo 🔄", action: "error" };
    }
    return { reply: `❌ Error: ${e?.message ?? String(e)}`, action: "error" };
  }
}
