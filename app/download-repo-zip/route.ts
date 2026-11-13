import { currentUser } from "@/lib/auth";
import { attachment, ghTokenOf, qs } from "@/lib/api-utils";
import { ghApi } from "@/lib/providers/github";
import { safeJsonify } from "@/lib/security";
import { gd } from "@/lib/commands/pyutil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return safeJsonify({ reply: "❌ Login chahiye.", action: "error" }, 401);
  const ghToken = ghTokenOf(user);
  const owner = user.github_login;

  const repo = qs(req, "repo");
  let branch = qs(req, "branch");
  if (!repo) return safeJsonify({ reply: "❌ repo naam chahiye.", action: "error" }, 400);

  if (!branch) {
    const repoR = await ghApi("GET", `/repos/${owner}/${repo}`, ghToken);
    if (repoR.status_code !== 200) {
      return safeJsonify({ reply: "❌ Repo nahi mila.", action: "error" }, repoR.status_code);
    }
    branch = gd(repoR.json(), "default_branch", "main");
  }

  const r = await ghApi("GET", `/repos/${owner}/${repo}/zipball/${branch}`, ghToken);
  if (r.status_code !== 200) {
    return safeJsonify(
      { reply: `❌ Zip download nahi hui (status ${r.status_code}).`, action: "error" },
      r.status_code
    );
  }

  return attachment(r.content, `${repo}-${branch}.zip`, "application/zip");
}
