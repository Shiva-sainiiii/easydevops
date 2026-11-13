import { currentUser } from "@/lib/auth";
import { ghTokenOf, qs } from "@/lib/api-utils";
import { ghApi } from "@/lib/providers/github";
import { safeJsonify, safeRepoPath, UnsafePathError } from "@/lib/security";
import { gd, K } from "@/lib/commands/pyutil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * JSON folder-listing (file-list bubble ke folder rows / breadcrumb ke liye).
 * Chat/regex parser ko bypass karta hai — path button click se already pata hota hai.
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return safeJsonify({ reply: "❌ Login chahiye.", action: "error" }, 401);
  const ghToken = ghTokenOf(user);
  const owner = user.github_login;

  const repo = qs(req, "repo");
  let path = qs(req, "path").replace(/^\/+|\/+$/g, "");
  if (!repo) return safeJsonify({ reply: "❌ Repo naam chahiye.", action: "error" }, 400);

  try {
    path = path ? safeRepoPath(path) : "";
  } catch (e: any) {
    if (e instanceof UnsafePathError) {
      return safeJsonify({ reply: `❌ Ye path allowed nahi hai: ${e.message}`, action: "error" }, 400);
    }
    throw e;
  }

  const endpoint = path ? `/repos/${owner}/${repo}/contents/${path}` : `/repos/${owner}/${repo}/contents`;
  const r = await ghApi("GET", endpoint, ghToken);
  if (r.status_code !== 200) {
    const msg = r.content.length ? gd(r.json(), "message", "Files fetch nahi hue") : "Files fetch nahi hue";
    return safeJsonify({ reply: `❌ GitHub: ${msg}`, action: "error" }, r.status_code);
  }

  const items = r.json();
  if (!Array.isArray(items)) {
    // File path click hua — list karne ko kuch nahi
    return safeJsonify({ reply: "❌ Ye path ek folder nahi hai.", action: "error" }, 400);
  }

  const itemList = items.map((item: any) => ({ type: K(item, "type"), path: K(item, "path"), name: K(item, "name") }));
  return safeJsonify({
    reply: `Files in \`${repo}/${path || ""}\`:`,
    action: "list_files",
    repo,
    path,
    items: itemList,
  });
}
