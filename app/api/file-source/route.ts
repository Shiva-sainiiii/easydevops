/**
 * INLINE CODE EDITOR backend.
 *  GET  /api/file-source  — editor ke liye file ka decoded text (JSON)
 *  POST /api/file-source  — editor content seedha GitHub contents PUT se commit (LLM ke beech me nahi)
 */
import { currentUser } from "@/lib/auth";
import { ghTokenOf, qs, sstr } from "@/lib/api-utils";
import { pyStr } from "@/lib/pyjson";
import { ghApi, getFileSha } from "@/lib/providers/github";
import { readJsonBody } from "@/lib/route-utils";
import { safeJsonify, safeRepoPath, UnsafePathError } from "@/lib/security";
import { gd, K } from "@/lib/commands/pyutil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_EDITOR_FILE_BYTES = 2 * 1024 * 1024; // 2MB

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
    const msg = r.content.length ? gd(r.json(), "message", "File nahi mili") : "File nahi mili";
    return safeJsonify({ reply: `❌ GitHub: ${msg}`, action: "error" }, r.status_code);
  }

  const data = r.json();
  if (gd(data, "type", null) !== "file") {
    return safeJsonify({ reply: "❌ Ye path ek file nahi hai.", action: "error" }, 400);
  }
  if (gd(data, "size", 0) > MAX_EDITOR_FILE_BYTES) {
    return safeJsonify(
      { reply: "❌ File bahut badi hai editor ke liye (2MB+). Download karke local me edit karo.", action: "error" },
      413
    );
  }

  const raw = Buffer.from(String(K(data, "content")), "base64");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    return safeJsonify({ reply: "❌ Ye binary file lag rahi hai — text editor me nahi khul sakti.", action: "error" }, 400);
  }

  return safeJsonify({ repo, path, content: text, sha: gd(data, "sha", null) });
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return safeJsonify({ reply: "❌ Login chahiye.", action: "error" }, 401);
  const ghToken = ghTokenOf(user);
  const owner = user.github_login;

  const body = await readJsonBody(req);
  const repo = sstr(body.repo);
  const rawPath = sstr(body.path);
  const content = gd(body, "content", null);
  const expectedSha = sstr(body.sha);
  let message = sstr(body.message);

  if (!repo || !rawPath || content === null) {
    return safeJsonify({ reply: "❌ repo, path aur content chahiye.", action: "error" }, 400);
  }

  let path: string;
  try {
    path = safeRepoPath(rawPath);
  } catch (e: any) {
    if (e instanceof UnsafePathError) {
      return safeJsonify({ reply: `❌ Ye path allowed nahi hai: ${e.message}`, action: "error" }, 400);
    }
    throw e;
  }

  if (Buffer.byteLength(String(content), "utf-8") > MAX_EDITOR_FILE_BYTES) {
    return safeJsonify({ reply: "❌ Content bahut bada hai (2MB+).", action: "error" }, 413);
  }

  const currentSha = await getFileSha(repo, path, owner, ghToken);
  if (!currentSha) {
    return safeJsonify({ reply: `❌ File \`${path}\` exist nahi karti repo \`${repo}\` me.`, action: "error" }, 404);
  }

  // sha match nahi => editor khulne ke baad file kahi aur se badli; blindly overwrite nahi
  if (expectedSha && expectedSha !== currentSha) {
    return safeJsonify(
      {
        reply: "⚠️ Ye file editor khulne ke baad kahi aur se update hui hai. Latest version reload karke dubara edit karo.",
        action: "conflict",
      },
      409
    );
  }

  if (!message) message = `Edit ${path} via inline editor`;

  const payload = {
    message,
    content: Buffer.from(String(content), "utf-8").toString("base64"),
    sha: currentSha,
  };
  const r = await ghApi("PUT", `/repos/${owner}/${repo}/contents/${path}`, ghToken, { json: payload });
  if (r.status_code === 200 || r.status_code === 201) {
    const url = K(K(r.json(), "content"), "html_url");
    const newSha = K(K(r.json(), "content"), "sha");
    return safeJsonify({
      reply: `✅ File save ho gayi!\n**${path}**\n🔗 ${pyStr(url)}`,
      action: "update_file",
      url,
      repo,
      path,
      sha: newSha,
    });
  }
  const err = r.content.length ? gd(r.json(), "message", "Save nahi hui") : "Save nahi hui";
  return safeJsonify({ reply: `❌ GitHub Error: ${err}`, action: "error" }, r.status_code);
}
