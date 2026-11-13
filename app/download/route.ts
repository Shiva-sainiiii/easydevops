import { currentUser } from "@/lib/auth";
import { attachment, ghTokenOf, guessMime, qs } from "@/lib/api-utils";
import { ghApi } from "@/lib/providers/github";
import { safeJsonify } from "@/lib/security";
import { gd, K } from "@/lib/commands/pyutil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return safeJsonify({ reply: "❌ Login chahiye.", action: "error" }, 401);
  const ghToken = ghTokenOf(user);
  const owner = user.github_login;

  const repo = qs(req, "repo");
  const path = qs(req, "path").replace(/^\/+/, "");
  if (!repo || !path) return safeJsonify({ reply: "❌ repo aur path chahiye.", action: "error" }, 400);

  const r = await ghApi("GET", `/repos/${owner}/${repo}/contents/${path}`, ghToken);
  if (r.status_code !== 200) {
    const msg = gd(r.json(), "message", "File nahi mili");
    return safeJsonify({ reply: `❌ GitHub: ${msg}`, action: "error" }, r.status_code);
  }
  const fileData = r.json();
  if (gd(fileData, "type", null) !== "file") {
    return safeJsonify({ reply: "❌ Ye path ek file nahi hai.", action: "error" }, 400);
  }
  const rawBytes = Buffer.from(String(K(fileData, "content")), "base64");
  const filename = path.split("/").pop() as string;
  return attachment(rawBytes, filename, guessMime(filename));
}
