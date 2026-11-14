/**
 * POST /chat — main command entrypoint. Teen stage:
 *  1. Confirmed destructive-action replay (pichle confirm_required se)
 *  2. Regex intent match -> direct execution, ya do AI-assisted paths (CREATE/EDIT_FILE, CODE_GENERATE)
 *  3. Full AI fallback jab koi regex rule match na kare
 */
import { clearSessionCookie, currentUser } from "@/lib/auth";
import { decryptToken, deleteUser, getUserNetlifyToken, getUserRenderToken, getUserVercelToken } from "@/lib/db";
import { Timeout } from "@/lib/http";
import { readJsonBody } from "@/lib/route-utils";
import { safeJsonify } from "@/lib/security";
import { buildConfirmation, confirmToken, DESTRUCTIVE_COMMANDS } from "@/lib/commands/confirmation";
import { executeCommand } from "@/lib/commands/executor";
import { NO_ARG_COMMANDS, parseIntent } from "@/lib/commands/intent_parser";
import { AIError, NoAIKeyError, callOpenrouterChat, extractCommand, handleCreateOrEditFile } from "@/lib/commands/ai_fallback";
import { handleCodeGenerate } from "@/lib/commands/code_generate";
import { guardRepoParam } from "@/lib/commands/collab";
import { ghRepoAccess, parseRepoRef, sameLogin } from "@/lib/providers/github";
import { generateRenderYaml } from "@/lib/commands/render_blueprint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) {
    return safeJsonify(
      {
        reply: "🔒 Pehle GitHub se connect karo — chat ke upar 'Connect GitHub' button dabao.",
        action: "auth_required",
        source: "direct",
      },
      401
    );
  }

  const ghToken = decryptToken(user.github_token_encrypted);
  if (!ghToken) {
    // Token decrypt nahi hua (jaise FERNET_KEY rotate hui) — force re-login
    await deleteUser(user.id);
    const resp = await safeJsonify(
      { reply: "🔒 Session expire ho gayi, dubara connect karo.", action: "auth_required", source: "direct" },
      401
    );
    clearSessionCookie(resp);
    return resp;
  }

  const owner = user.github_login;
  const vcToken = getUserVercelToken(user);
  const nlToken = getUserNetlifyToken(user);
  const rdToken = getUserRenderToken(user);
  const body = await readJsonBody(req);

  // 1. CONFIRMED DESTRUCTIVE ACTION REPLAY
  if (body.confirmed) {
    const cmd = body.pending_command;
    const value = body.pending_value;
    const token = body.confirm_token;
    if (!DESTRUCTIVE_COMMANDS.has(cmd) || token !== confirmToken(cmd, value, user.id)) {
      return safeJsonify({
        reply: "❌ Confirmation token match nahi hua. Dobara try kar.",
        action: "error",
        source: "direct",
      });
    }
    let params: Record<string, any> = {};
    try {
      params = value && typeof value === "string" ? JSON.parse(value) : {};
    } catch {
      params = {};
    }
    const result = await executeCommand(cmd, params, owner, ghToken, vcToken, nlToken, rdToken);
    result.source = "direct";
    return safeJsonify(result);
  }

  const userMessage = typeof body.message === "string" ? body.message.trim() : "";
  const convHistory = "history" in body ? body.history : [];

  if (!userMessage) {
    return safeJsonify({ reply: "Kuch toh bol bhai 😅", action: null, source: "direct" });
  }

  // 2. STRUCTURAL INTENT MATCH
  const [cmd, params] = parseIntent(userMessage);

  if (cmd) {
    // `owner/repo`: galat format / doosre ke repo pe write command ko AI call ya confirm prompt se PEHLE rok do
    const blocked = guardRepoParam(cmd, params, owner);
    if (blocked) {
      blocked.source = "direct";
      return safeJsonify(blocked);
    }

    if (cmd === "CREATE_FILE" || cmd === "EDIT_FILE") {
      try {
        const result = await handleCreateOrEditFile(cmd, params, userMessage, owner, ghToken, user.id);
        return safeJsonify(result);
      } catch (e: any) {
        if (e instanceof NoAIKeyError) {
          return safeJsonify({ reply: e.message, action: "ai_setup_required", source: "hybrid" });
        }
        if (e instanceof AIError) {
          return safeJsonify({ reply: `❌ AI Error: ${e.message}`, action: "error", source: "hybrid" });
        }
        if (e instanceof Timeout) {
          return safeJsonify({
            reply: "AI ne content generate karne me bahut time lagaya. Dobara try karo 🔄",
            action: "error",
            source: "hybrid",
          });
        }
        return safeJsonify({ reply: `❌ Error: ${e?.message ?? String(e)}`, action: "error", source: "hybrid" });
      }
    }

    if (cmd === "GENERATE_RENDER_YAML") {
      try {
        const result = await generateRenderYaml(params["repo"], owner, ghToken);
        result.source = "direct";
        return safeJsonify(result);
      } catch (e: any) {
        return safeJsonify({ reply: `❌ Error: ${e?.message ?? String(e)}`, action: "error", source: "direct" });
      }
    }

    if (cmd === "CODE_GENERATE") {
      try {
        params["instruction"] = userMessage;
        // Phase 3: `owner/repo` (doosra owner) -> push access check, phir hamesha branch + PR (direct commit nahi)
        let cgOwner = owner;
        let cgForeign = false;
        const refStr = typeof params["repo"] === "string" ? params["repo"] : "";
        if (refStr.includes("/")) {
          const ref = parseRepoRef(refStr, owner);
          if (ref && !sameLogin(ref.owner, owner)) {
            const [acc, accErr] = await ghRepoAccess(ref.owner, ref.repo, ghToken);
            if (!acc) return safeJsonify({ reply: accErr, action: "error", source: "direct" });
            if (!acc.push) {
              return safeJsonify({
                reply: `🔒 \`${ref.owner}/${ref.repo}\` me changes ke liye kam se kam **push** access chahiye (tumhari permission: **${acc.role}**).`,
                action: "warning",
                source: "direct",
              });
            }
            cgOwner = ref.owner;
            cgForeign = true;
            params["repo"] = ref.repo;
          }
        }
        const result = await handleCodeGenerate(params, cgOwner, ghToken, user.id, { forcePr: cgForeign });
        if (cgForeign && typeof result["repo"] === "string") result["repo"] = `${cgOwner}/${result["repo"]}`;
        return safeJsonify(result);
      } catch (e: any) {
        if (e instanceof NoAIKeyError) {
          return safeJsonify({ reply: e.message, action: "ai_setup_required", source: "hybrid" });
        }
        if (e instanceof AIError) {
          return safeJsonify({ reply: `❌ AI Error: ${e.message}`, action: "error", source: "hybrid" });
        }
        if (e instanceof Timeout) {
          return safeJsonify({
            reply: "AI ne code generate karne me bahut time lagaya. Dobara try karo 🔄",
            action: "error",
            source: "hybrid",
          });
        }
        return safeJsonify({ reply: `❌ Error: ${e?.message ?? String(e)}`, action: "error", source: "hybrid" });
      }
    }

    if (DESTRUCTIVE_COMMANDS.has(cmd)) {
      return safeJsonify(buildConfirmation(cmd, params, user.id));
    }

    const result = await executeCommand(cmd, params, owner, ghToken, vcToken, nlToken, rdToken);
    result.source = "direct";
    result.action_command = cmd;
    return safeJsonify(result);
  }

  // 3. AI FALLBACK
  let aiText: string;
  try {
    aiText = await callOpenrouterChat(userMessage, convHistory, owner, !!vcToken, !!nlToken, !!rdToken, user.id);
  } catch (e: any) {
    if (e instanceof NoAIKeyError) {
      return safeJsonify({ reply: e.message, action: "ai_setup_required", source: "ai" });
    }
    if (e instanceof AIError) {
      return safeJsonify({ reply: `AI Error: ${e.message}`, action: "error", source: "ai" });
    }
    if (e instanceof Timeout) {
      return safeJsonify({
        reply: "AI ne jawab dene me bahut time lagaya. Dobara try karo 🔄",
        action: "error",
        source: "ai",
      });
    }
    return safeJsonify({ reply: `AI connection error: ${e?.message ?? String(e)}`, action: "error", source: "ai" });
  }

  const [aiCmd, aiValue] = extractCommand(aiText);

  if (aiCmd) {
    let aiParams: Record<string, any>;
    if (NO_ARG_COMMANDS.has(aiCmd)) {
      aiParams = {};
    } else {
      try {
        if (aiValue && aiValue.trim().startsWith("{")) {
          aiParams = JSON.parse(aiValue);
        } else if (aiCmd === "CREATE_REPO" || aiCmd === "DELETE_REPO") {
          aiParams = { repo: (aiValue || "").trim() };
        } else {
          aiParams = {};
        }
      } catch {
        return safeJsonify({
          reply: "❌ AI ne sahi JSON nahi diya. Dobara try karo.",
          action: "error",
          source: "ai",
        });
      }
    }

    const aiBlocked = guardRepoParam(aiCmd, aiParams, owner);
    if (aiBlocked) {
      aiBlocked.source = "ai";
      return safeJsonify(aiBlocked);
    }

    if (DESTRUCTIVE_COMMANDS.has(aiCmd)) {
      return safeJsonify(buildConfirmation(aiCmd, aiParams, user.id));
    }

    const result = await executeCommand(aiCmd, aiParams, owner, ghToken, vcToken, nlToken, rdToken);
    result.source = "ai";
    result.action_command = aiCmd;
    return safeJsonify(result);
  }

  return safeJsonify({ reply: aiText, action: "message", source: "ai" });
}
