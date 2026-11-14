/**
 * COLLABORATION (Phase 4): activity/notifications feed, PR preview URL, fork-based contribution.
 *
 * - Notifications: GitHub `GET /notifications` poll (webhooks nahi). User ke apne token se.
 * - Preview URL: GitHub Deployments API ke statuses se (Vercel GitHub integration wahan
 *   `environment_url` post karta hai) — isliye Vercel token ki zaroorat nahi, aur dost bhi dekh sakta hai.
 * - Fork flow: invite ke bina — fork karo, apne fork pe kaam, phir upstream pe cross-fork PR.
 */
import { gd, req } from "@/lib/commands/pyutil";
import { ghApi, ghMsg, sameLogin, type RepoAccess } from "@/lib/providers/github";
import { createPullRequest } from "@/lib/commands/code_generate";

type Result = Record<string, any>;

export const NOTIFY_COMMANDS = new Set(["LIST_NOTIFICATIONS", "MARK_NOTIFICATIONS_READ"]);
export const FORK_COMMANDS = new Set(["FORK_REPO", "CREATE_FORK_PR"]);

// ════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ════════════════════════════════════════════════════════════════

const REASON_LABEL: Record<string, string> = {
  review_requested: "review maanga gaya",
  mention: "tumhe mention kiya",
  team_mention: "team mention",
  assign: "tumhe assign kiya",
  author: "tumhare PR/issue pe activity",
  comment: "naya comment",
  state_change: "state badli (merge/close)",
  ci_activity: "CI result",
  invitation: "invitation",
  subscribed: "watching repo",
  manual: "subscribed",
  security_alert: "security alert",
};

const TYPE_ICON: Record<string, string> = {
  PullRequest: "🔀",
  Issue: "🐞",
  Commit: "📝",
  CheckSuite: "⚙️",
  Release: "🏷️",
  Discussion: "💬",
  RepositoryInvitation: "📨",
};

function notifHtmlUrl(n: any): string {
  const repoUrl: string = n?.repository?.html_url ?? "";
  const apiUrl: string = n?.subject?.url ?? "";
  const num = /\/(?:pulls|issues)\/(\d+)$/.exec(apiUrl)?.[1];
  if (n?.subject?.type === "PullRequest" && num) return `${repoUrl}/pull/${num}`;
  if (n?.subject?.type === "Issue" && num) return `${repoUrl}/issues/${num}`;
  if (n?.subject?.type === "RepositoryInvitation") return `${repoUrl}/invitations`;
  return repoUrl;
}

export async function executeNotifyCommand(cmd: string, p: Record<string, any>, ghToken: string): Promise<Result> {
  if (cmd === "MARK_NOTIFICATIONS_READ") {
    const r = await ghApi("PUT", "/notifications", ghToken, { json: { last_read_at: new Date().toISOString(), read: true } });
    if (r.status_code === 202 || r.status_code === 205 || r.status_code === 200) {
      return { reply: "✅ Saari notifications read mark ho gayi.", action: "notifications_read" };
    }
    if (r.status_code === 403 || r.status_code === 401) {
      return { reply: `🔒 GitHub ne notifications ka access nahi diya (${r.status_code}). Logout karke dubara GitHub se connect karo.`, action: "error" };
    }
    return { reply: `❌ Notifications read mark nahi hui (${r.status_code}): ${ghMsg(r)}`, action: "error" };
  }

  // LIST_NOTIFICATIONS
  const all = p.all === true || String(p.all ?? "").toLowerCase() === "true";
  const r = await ghApi("GET", `/notifications?all=${all ? "true" : "false"}&per_page=30`, ghToken);
  if (r.status_code === 401 || r.status_code === 403) {
    return { reply: `🔒 GitHub ne notifications ka access nahi diya (${r.status_code}): ${ghMsg(r)}. Logout karke dubara connect karo.`, action: "error" };
  }
  if (r.status_code !== 200) return { reply: `❌ Notifications fetch nahi hui (${r.status_code}): ${ghMsg(r)}`, action: "error" };
  const raw: any[] = Array.isArray(r.json()) ? r.json() : [];
  const items = raw.map((n) => ({
    id: n.id,
    unread: !!n.unread,
    reason: n.reason ?? "",
    reason_label: REASON_LABEL[n.reason] ?? n.reason ?? "",
    type: n?.subject?.type ?? "",
    title: n?.subject?.title ?? "",
    repo: n?.repository?.full_name ?? "",
    url: notifHtmlUrl(n),
    updated_at: n.updated_at ?? null,
  }));
  if (!items.length) {
    return { reply: all ? "📭 Koi notification nahi hai." : "📭 Koi unread notification nahi hai. Sab clear! ✨", action: "notifications", notifications: [] };
  }
  const lines = items.map((i) => `${TYPE_ICON[i.type] ?? "🔔"} ${i.unread ? "**" : ""}${i.title}${i.unread ? "**" : ""} — \`${i.repo}\` — ${i.reason_label}\n  🔗 ${i.url}`);
  return {
    reply: `🔔 ${items.length} ${all ? "" : "unread "}notification${items.length !== 1 ? "s" : ""}:\n\n` + lines.join("\n") +
      `\n\n💡 Sab clear karne ke liye: \`mark notifications read\``,
    action: "notifications",
    notifications: items,
    all,
  };
}

// ════════════════════════════════════════════════════════════════
// PR PREVIEW URL (GitHub Deployments API)
// ════════════════════════════════════════════════════════════════

/**
 * PR head ka preview/deploy URL. Pehle head SHA ke deployments, na mile to head branch ke.
 * Returns { url, environment, state } ya null (koi deployment nahi / access nahi).
 */
export async function findPreviewUrl(
  owner: string,
  repo: string,
  headSha: string | null,
  headRef: string | null,
  ghToken: string
): Promise<{ url: string; environment: string; state: string } | null> {
  const queries: string[] = [];
  if (headSha) queries.push(`sha=${encodeURIComponent(headSha)}`);
  if (headRef) queries.push(`ref=${encodeURIComponent(headRef)}`);
  for (const q of queries) {
    const d = await ghApi("GET", `/repos/${owner}/${repo}/deployments?${q}&per_page=5`, ghToken);
    if (d.status_code !== 200 || !Array.isArray(d.json())) continue;
    for (const dep of d.json() as any[]) {
      const s = await ghApi("GET", `/repos/${owner}/${repo}/deployments/${dep.id}/statuses?per_page=5`, ghToken);
      if (s.status_code !== 200 || !Array.isArray(s.json())) continue;
      for (const st of s.json() as any[]) {
        const url: string = st?.environment_url || st?.target_url || "";
        if (url && /^https?:\/\//.test(url)) {
          return { url, environment: String(dep?.environment ?? ""), state: String(st?.state ?? "") };
        }
      }
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════════════
// FORK FLOW
// ════════════════════════════════════════════════════════════════

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;

/**
 * FORK_REPO {repo: "owner/repo"} — upstream (doosre ka) repo ko apne account me fork.
 * CREATE_FORK_PR {repo: "owner/repo", head: "branch-in-my-fork", base?, title?, body?}
 * `owner` yahan UPSTREAM owner hai (executor ne resolve kiya); `selfLogin` calling user.
 */
export async function executeForkCommand(
  cmd: string,
  p: Record<string, any>,
  owner: string,
  ghToken: string,
  selfLogin: string,
  acc: RepoAccess
): Promise<Result> {
  const repo = String(req(p, "repo")).trim();
  const upstream = `${owner}/${repo}`;
  if (sameLogin(owner, selfLogin)) {
    return { reply: "ℹ️ Ye tumhara apna repo hai — fork ki zaroorat nahi. Branch banao aur seedha kaam karo.", action: "warning" };
  }

  if (cmd === "FORK_REPO") {
    // Pehle se fork hai?
    const mine = await ghApi("GET", `/repos/${selfLogin}/${repo}`, ghToken);
    if (mine.status_code === 200 && mine.json()?.fork && String(mine.json()?.parent?.full_name ?? "").toLowerCase() === upstream.toLowerCase()) {
      return {
        reply: `ℹ️ \`${selfLogin}/${repo}\` pehle se \`${upstream}\` ka fork hai.\nAb uspe kaam karo (\`create branch x in ${repo}\`), phir: \`send pr from x to ${upstream}\``,
        action: "fork_repo",
        repo: `${selfLogin}/${repo}`,
        upstream,
      };
    }
    const r = await ghApi("POST", `/repos/${owner}/${repo}/forks`, ghToken, { json: {} });
    if (r.status_code === 202 || r.status_code === 200 || r.status_code === 201) {
      const d = r.json();
      const fullName = d?.full_name ?? `${selfLogin}/${repo}`;
      return {
        reply:
          `🍴 Fork ban raha hai: **${fullName}** (\`${upstream}\` se)\n🔗 ${d?.html_url ?? ""}\n` +
          `GitHub ko bade repo me thodi der lag sakti hai. Phir:\n` +
          `1. \`create branch my-change in ${d?.name ?? repo}\`\n2. file edit / AI se changes\n3. \`send pr from my-change to ${upstream}\``,
        action: "fork_repo",
        repo: fullName,
        upstream,
        url: d?.html_url ?? "",
      };
    }
    if (r.status_code === 403) return { reply: `🔒 GitHub ne fork allow nahi kiya (403): ${ghMsg(r)}`, action: "error" };
    if (r.status_code === 404) return { reply: `❌ \`${upstream}\` nahi mila ya fork allowed nahi hai.`, action: "error" };
    if (r.status_code === 422) return { reply: `❌ Fork nahi ho paya (422): ${ghMsg(r)}`, action: "error" };
    return { reply: `❌ Fork fail hua (${r.status_code}): ${ghMsg(r)}`, action: "error" };
  }

  // CREATE_FORK_PR
  const head = String(req(p, "head")).trim();
  if (!BRANCH_RE.test(head) || head.includes("..")) {
    return { reply: `❌ Branch naam \`${head}\` valid nahi hai.`, action: "error" };
  }
  const base = String(gd(p, "base", "") || "").trim() || acc.defaultBranch || "main";
  const mine = await ghApi("GET", `/repos/${selfLogin}/${repo}`, ghToken);
  if (mine.status_code === 404) {
    return { reply: `❌ Tumhare paas \`${repo}\` ka fork nahi hai. Pehle: \`fork ${upstream}\``, action: "error" };
  }
  if (mine.status_code !== 200) return { reply: `❌ Fork check fail hua (${mine.status_code}): ${ghMsg(mine)}`, action: "error" };
  const m = mine.json();
  if (!m?.fork || String(m?.parent?.full_name ?? "").toLowerCase() !== upstream.toLowerCase()) {
    return { reply: `❌ \`${selfLogin}/${repo}\` \`${upstream}\` ka fork nahi hai. Pehle: \`fork ${upstream}\``, action: "error" };
  }
  const br = await ghApi("GET", `/repos/${selfLogin}/${repo}/git/ref/heads/${head.split("/").map(encodeURIComponent).join("/")}`, ghToken);
  if (br.status_code === 404) {
    return { reply: `❌ Tumhare fork me branch \`${head}\` nahi hai. Pehle: \`create branch ${head} in ${repo}\``, action: "error" };
  }

  const title = String(gd(p, "title", "") || "").trim().slice(0, 200) || `Changes from ${selfLogin}:${head}`;
  const body = String(gd(p, "body", "") || "").slice(0, 4000) || "Opened via Easy DevOps (fork).";
  const [ok, err, url] = await createPullRequest(owner, repo, ghToken, `${selfLogin}:${head}`, base, title, body);
  if (ok) {
    return {
      reply: `✅ PR khul gaya: \`${selfLogin}:${head}\` → \`${upstream}:${base}\`\n🔀 ${url}`,
      action: "pr_created",
      repo: upstream,
      head: `${selfLogin}:${head}`,
      base,
      pr_url: url,
    };
  }
  return { reply: `❌ PR create nahi hua: ${err}`, action: "error" };
}
