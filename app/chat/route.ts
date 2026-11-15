/**
 * POST /chat — main command entrypoint. Stages:
 *  0. Rate limit + "logout everywhere"
 *  1. Confirmed action replay (HMAC token, 15 min expiry, single-use) — single command ya multi-step PLAN
 *  2. classifyMessage (rules, 0 AI tokens):
 *       chain     -> multi-step plan rules se (jaise "create repo x and add index.html with <code> and deploy")
 *       single    -> ek command (purana flow, AI-assisted CREATE/EDIT_FILE + CODE_GENERATE samet)
 *       needs_ai  -> message partial/uncertain: tab hi AI planner (ek chhota call)
 *       none      -> koi rule nahi
 *  3. AI chat fallback (sirf jab upar kuch na mile). AI-origin write commands confirm maangte hain.
 */
import { clearSessionCookie, currentUser } from "@/lib/auth";
import {
  bumpSessionVersion,
  consumeConfirmToken,
  decryptToken,
  getUserNetlifyToken,
  getUserRenderToken,
  getUserVercelToken,
} from "@/lib/db";
import { Timeout } from "@/lib/http";
import { rateLimitUser, tooManyRequests } from "@/lib/ratelimit";
import { readJsonBody } from "@/lib/route-utils";
import { safeJsonify } from "@/lib/security";
import {
  buildAiConfirmation,
  buildConfirmation,
  buildPlanConfirmation,
  verifyConfirmToken,
  DESTRUCTIVE_COMMANDS,
} from "@/lib/commands/confirmation";
import { executeCommand } from "@/lib/commands/executor";
import { NO_ARG_COMMANDS } from "@/lib/commands/intent_parser";
import { AIError, NoAIKeyError, callOpenrouterChat, extractCommand, handleCreateOrEditFile } from "@/lib/commands/ai_fallback";
import { handleCodeGenerate } from "@/lib/commands/code_generate";
import { guardRepoParam } from "@/lib/commands/collab";
import { classifyMessage, isDestructiveStep, MAX_STEPS, SAFE_SEED_REPO, type PlanStep } from "@/lib/commands/chain";
import { planWithAI } from "@/lib/commands/planner";
import { runPlan } from "@/lib/commands/plan_runner";
import { isKnownCommand, needsConfirmation } from "@/lib/commands/risk";
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

  const rl = await rateLimitUser(user.id, "chat", 40, 60);
  if (!rl.ok) return tooManyRequests(rl);

  const ghToken = decryptToken(user.github_token_encrypted);
  if (!ghToken) {
    // Token decrypt nahi hua (FERNET_KEY badli / galat env). User ka data DELETE NAHI karte (pehle karte the —
    // galat env wale preview deploy se asli users ka data ud sakta tha); bas dubara login karwao, login pe token re-encrypt hota hai.
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

  const runCtx = {
    owner,
    ghToken,
    vcToken,
    nlToken,
    rdToken,
    userId: user.id,
  };

  // 1. CONFIRMED ACTION REPLAY (destructive, AI-suggested, ya multi-step PLAN)
  if (body.confirmed) {
    const cmd = typeof body.pending_command === "string" ? body.pending_command : "";
    const value = typeof body.pending_value === "string" ? body.pending_value : "";
    const token = body.confirm_token;
    const check = isKnownCommand(cmd) || cmd === "PLAN" ? verifyConfirmToken(token, cmd, value, user.id) : "bad";
    if (check === "expired") {
      return safeJsonify({
        reply: "⌛ Confirmation expire ho gaya (15 min se zyada ho gaye). Command dobara bhejo.",
        action: "error",
        source: "direct",
      });
    }
    if (check !== "ok") {
      return safeJsonify({
        reply: "❌ Confirmation token match nahi hua. Dobara try kar.",
        action: "error",
        source: "direct",
      });
    }
    // Single-use: wahi "Haan" do baar (double-tap / replay) nahi chalega
    if (!(await consumeConfirmToken(String(token), user.id))) {
      return safeJsonify({
        reply: "ℹ️ Ye action pehle hi chal chuka hai (confirmation ek hi baar kaam karta hai).",
        action: "warning",
        source: "direct",
      });
    }

    if (cmd === "PLAN") {
      let plan: { steps?: PlanStep[]; blocks?: string[] } = {};
      try {
        plan = JSON.parse(value);
      } catch {
        plan = {};
      }
      const steps = Array.isArray(plan.steps) ? plan.steps : [];
      if (!steps.length || steps.length > MAX_STEPS || !steps.every((st) => st && isKnownCommand(String(st.cmd)))) {
        return safeJsonify({ reply: "❌ Plan padha nahi ja saka. Dobara bhejo.", action: "error", source: "direct" });
      }
      const blocks = Array.isArray(plan.blocks) ? plan.blocks.map(String) : [];
      return safeJsonify(await runPlan(steps, blocks, { ...runCtx, source: "direct" }));
    }

    let params: Record<string, any> = {};
    try {
      params = value ? JSON.parse(value) : {};
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

  // "Logout everywhere" — rules se, 0 AI
  if (/^(?:log\s*out|sign\s*out|logout)\s+(?:from\s+)?(?:all|everywhere|sab|saare|sare)(?:\s+(?:devices?|sessions?|jagah))?$/i.test(userMessage)) {
    await bumpSessionVersion(user.id);
    const resp = await safeJsonify({
      reply: "🔐 Saare devices/browsers se logout ho gaya. Dubara use karne ke liye GitHub se connect karo.",
      action: "auth_required",
      source: "direct",
    });
    clearSessionCookie(resp);
    return resp;
  }

  // Plan chalane ka common helper: destructive step ho to pehle poore plan ka ek confirm
  const respondPlan = async (steps: PlanStep[], blocks: string[], source: "direct" | "hybrid") => {
    if (steps.some(isDestructiveStep)) {
      return safeJsonify(buildPlanConfirmation(steps, JSON.stringify({ steps, blocks }), user.id));
    }
    return safeJsonify(await runPlan(steps, blocks, { ...runCtx, source }));
  };

  // UI ne "file/zip + task" bheja ho to upload ke baad ka repo context (sirf safe naam, warna ignore)
  const ctxRepoRaw = body.context && typeof body.context === "object" ? (body.context as any).repo : "";
  const seedRepo = typeof ctxRepoRaw === "string" && SAFE_SEED_REPO.test(ctxRepoRaw) ? ctxRepoRaw : "";

  // 2. CLASSIFY (rules, 0 AI tokens)
  const cls = classifyMessage(userMessage, seedRepo || null);

  if (cls.kind === "chain") {
    return respondPlan(cls.steps, cls.blocks, "direct");
  }

  if (cls.kind === "needs_ai") {
    // Message ek se zyada kaam ka lagta hai ya rules poora samajh nahi paaye -> AI planner (ek chhota call)
    const aiRl = await rateLimitUser(user.id, "ai", 12, 60);
    if (!aiRl.ok) return tooManyRequests(aiRl);
    const manual = () => {
      if (cls.reason === "partial" && cls.understood) {
        return safeJsonify({
          reply:
            `⚠️ Maine \`${cls.understood.cmd}\` samjha, par message me kuch aur bhi hai (\`${cls.unresolved[0]}\`). ` +
            `Kuch galat na ho isliye abhi kuch nahi chalaya — ek-ek kaam alag message me bhejo, ya AI Gateway me key lagao to main multi-step khud samajh lunga.`,
          action: "warning",
          source: "direct",
        });
      }
      return safeJsonify({
        reply:
          `⚠️ Is message ke ye hisse mujhe samajh nahi aaye: ${cls.unresolved.map((u) => `\`${u}\``).join(", ")}.\n` +
          `Kuch nahi chalaya. Ek-ek kaam alag message me bhejo, ya AI Gateway me key lagao to main complex tasks khud todke chala dunga.`,
        action: "warning",
        source: "direct",
      });
    };
    try {
      const plannerText = seedRepo
        ? `[Context: user ne abhi apni files/zip repo "${seedRepo}" me upload kar di hain. Upload ka kaam ho chuka hai — usse dobara plan mat karo, sirf baaki task ke steps do. Repo ka naam "${seedRepo}" hai.]\n${cls.text}`
        : cls.text;
      const plan = await planWithAI(plannerText, cls.blocks.length, user.id, {
        vercel: !!vcToken,
        netlify: !!nlToken,
        render: !!rdToken,
      });
      if (plan.ask) return safeJsonify({ reply: plan.ask, action: "message", source: "ai" });
      if (plan.steps?.length) return respondPlan(plan.steps, cls.blocks, "hybrid");
      return safeJsonify({
        reply: `🤔 AI plan nahi bana paya${plan.error ? ` (${plan.error})` : ""}. Ek-ek kaam alag message me bhejo.`,
        action: "warning",
        source: "ai",
      });
    } catch (e: any) {
      if (e instanceof NoAIKeyError) return manual();
      if (e instanceof AIError || e instanceof Timeout) return manual();
      return safeJsonify({ reply: `❌ Error: ${e?.message ?? String(e)}`, action: "error", source: "ai" });
    }
  }

  const [cmd, params]: [string | null, Record<string, any> | null] =
    cls.kind === "single" ? [cls.match.cmd, cls.match.params] : [null, null];

  if (cmd && params) {
    // `owner/repo`: galat format / doosre ke repo pe write command ko AI call ya confirm prompt se PEHLE rok do
    const blocked = guardRepoParam(cmd, params, owner);
    if (blocked) {
      blocked.source = "direct";
      return safeJsonify(blocked);
    }

    if (cmd === "CREATE_FILE" || cmd === "EDIT_FILE" || cmd === "CODE_GENERATE") {
      const aiRl = await rateLimitUser(user.id, "ai", 12, 60);
      if (!aiRl.ok) return tooManyRequests(aiRl);
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
  const fbRl = await rateLimitUser(user.id, "ai", 12, 60);
  if (!fbRl.ok) return tooManyRequests(fbRl);
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
    // AI ka suggest kiya hua koi bhi write action bina user ke "Haan" ke nahi chalta (prompt-injection guard)
    if (needsConfirmation(aiCmd, "ai")) {
      return safeJsonify(buildAiConfirmation(aiCmd, aiParams, user.id));
    }

    const result = await executeCommand(aiCmd, aiParams, owner, ghToken, vcToken, nlToken, rdToken);
    result.source = "ai";
    result.action_command = aiCmd;
    return safeJsonify(result);
  }

  return safeJsonify({ reply: aiText, action: "message", source: "ai" });
}
