import { currentUser } from "@/lib/auth";
import { ghTokenOf, qs } from "@/lib/api-utils";
import { ghApi } from "@/lib/providers/github";
import { safeJsonify } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Recursive git tree se folders (command-form autofill)
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return safeJsonify({ folders: [] });
  const ghToken = ghTokenOf(user);
  const owner = user.github_login;
  const repo = qs(req, "repo");
  if (!repo) return safeJsonify({ folders: [] });

  const repoR = await ghApi("GET", `/repos/${owner}/${repo}`, ghToken);
  if (repoR.status_code !== 200) return safeJsonify({ folders: [] });
  const defaultBranch = repoR.json().default_branch ?? "main";

  const treeR = await ghApi("GET", `/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`, ghToken);
  if (treeR.status_code !== 200) return safeJsonify({ folders: [] });

  const tree: any[] = treeR.json().tree ?? [];
  const folders = Array.from(new Set(tree.filter((item) => item.type === "tree").map((item) => item["path"] as string))).sort();
  return safeJsonify({ folders });
}
