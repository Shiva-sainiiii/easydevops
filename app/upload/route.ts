import { currentUser } from "@/lib/auth";
import { formFile, formStr, ghTokenOf, readForm } from "@/lib/api-utils";
import { ghApi, getFileSha } from "@/lib/providers/github";
import { safeJsonify, safeRepoPath, UnsafePathError } from "@/lib/security";
import { gd, K } from "@/lib/commands/pyutil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return safeJsonify({ reply: "❌ Login chahiye.", action: "error", source: "direct" }, 401);
  const ghToken = ghTokenOf(user);
  const owner = user.github_login;

  const form = await readForm(req);
  const repo = formStr(form, "repo");
  let path = formStr(form, "path");
  let message = formStr(form, "message");
  const f = formFile(form, "file");

  if (!repo) return safeJsonify({ reply: "❌ Repo naam nahi diya.", action: "error", source: "direct" }, 400);
  if (!f || f.name === "") {
    return safeJsonify({ reply: "❌ Koi file select nahi hui.", action: "error", source: "direct" }, 400);
  }
  if (!path) path = f.name;
  try {
    path = safeRepoPath(path);
  } catch (e: any) {
    if (e instanceof UnsafePathError) {
      return safeJsonify(
        { reply: `❌ Ye path allowed nahi hai: ${e.message}`, action: "error", source: "direct" },
        400
      );
    }
    throw e;
  }

  const raw = Buffer.from(await f.arrayBuffer());
  if (raw.length > MAX_UPLOAD_BYTES) {
    const sizeMb = raw.length / (1024 * 1024);
    return safeJsonify(
      {
        reply: `❌ File bahut badi hai (${sizeMb.toFixed(1)} MB). 25MB tak hi supported hai.`,
        action: "error",
        source: "direct",
      },
      413
    );
  }

  if (!message) message = `Upload ${path} via Easy DevOps`;

  const contentB64 = raw.toString("base64");
  const existingSha = await getFileSha(repo, path, owner, ghToken);
  const payload: Record<string, any> = { message, content: contentB64 };
  if (existingSha) payload.sha = existingSha;

  const r = await ghApi("PUT", `/repos/${owner}/${repo}/contents/${path}`, ghToken, { json: payload });
  if (r.status_code === 200 || r.status_code === 201) {
    const url = K(K(r.json(), "content"), "html_url");
    const action = existingSha ? "update_file" : "create_file";
    const verb = existingSha ? "Update" : "Upload";
    const sizeKb = raw.length / 1024;
    return safeJsonify({
      reply: `✅ File ${verb} ho gayi!\n**${path}** (${sizeKb.toFixed(1)} KB)\n🔗 ${url}`,
      action,
      url,
      repo,
      source: "direct",
    });
  } else {
    let errMsg = "File upload nahi hui";
    try {
      errMsg = gd(r.json(), "message", errMsg);
    } catch {
      /* body JSON nahi tha */
    }
    return safeJsonify({ reply: `❌ GitHub Error: ${errMsg}`, action: "error", source: "direct" }, r.status_code);
  }
}
