/**
 * PLAN RUNNER — steps ko ek ke baad ek chalata hai (executor ke through, user ke apne tokens se).
 * AI tokens: 0 (sirf wahi step AI use karta hai jiska content/code AI se banwana ho).
 *
 *  - Pehla fail hote hi ruk jata hai; baaki steps "skipped" dikhte hain.
 *  - Naya repo banne ke turant baad GitHub kabhi-kabhi 404 deta hai — us repo ke steps ko chhota retry milta hai.
 *  - 60s serverless limit: ~42s ke baad naya step shuru nahi hota, bacha hua plan batata hai.
 */
import { AIError, NoAIKeyError, handleCreateOrEditFile } from "@/lib/commands/ai_fallback";
import { fillBlocks, type PlanStep } from "@/lib/commands/chain";
import { handleCodeGenerate } from "@/lib/commands/code_generate";
import { guardRepoParam } from "@/lib/commands/collab";
import { executeCommand } from "@/lib/commands/executor";
import { generateRenderYaml } from "@/lib/commands/render_blueprint";
import { Timeout } from "@/lib/http";

export interface RunCtx {
  owner: string;
  ghToken: string;
  vcToken: string | null;
  nlToken: string | null;
  rdToken: string | null;
  userId: number | string;
  source: "direct" | "hybrid";
}

const DEADLINE_MS = 42_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isAuthAction = (a: any) => typeof a === "string" && (a.endsWith("_auth_required") || a === "ai_setup_required");

/** Step safal mana jayega? ("Repo already exist" warning plan ko rokta nahi.) */
export function stepOk(res: Record<string, any>): boolean {
  const a = res?.action;
  if (a === "error" || isAuthAction(a)) return false;
  if (a === "warning") return /already exist/i.test(String(res.reply || ""));
  return true;
}

async function runOne(step: PlanStep, blocks: string[], ctx: RunCtx): Promise<Record<string, any>> {
  const params = fillBlocks(step.params, blocks);
  const blocked = guardRepoParam(step.cmd, params, ctx.owner);
  if (blocked) return blocked;
  try {
    if ((step.cmd === "CREATE_FILE" || step.cmd === "EDIT_FILE") && typeof params.content !== "string") {
      return await handleCreateOrEditFile(
        step.cmd,
        params,
        step.instruction || `${step.cmd === "EDIT_FILE" ? "Update" : "Create"} ${params.path}`,
        ctx.owner,
        ctx.ghToken,
        ctx.userId
      );
    }
    if (step.cmd === "CODE_GENERATE") {
      if (typeof params.repo === "string" && params.repo.includes("/")) {
        return { reply: "ℹ️ Doosre ke repo pe code-generate alag message me bhejo (wo branch + PR banata hai).", action: "warning" };
      }
      params.instruction = step.instruction || params.instruction;
      return await handleCodeGenerate(params, ctx.owner, ctx.ghToken, ctx.userId);
    }
    if (step.cmd === "GENERATE_RENDER_YAML") return await generateRenderYaml(params.repo, ctx.owner, ctx.ghToken);
    return await executeCommand(step.cmd, params, ctx.owner, ctx.ghToken, ctx.vcToken, ctx.nlToken, ctx.rdToken);
  } catch (e: any) {
    if (e instanceof NoAIKeyError) return { reply: e.message, action: "ai_setup_required" };
    if (e instanceof AIError) return { reply: `❌ AI Error: ${e.message}`, action: "error" };
    if (e instanceof Timeout) return { reply: "❌ Timeout — thodi der baad dobara try karo.", action: "error" };
    return { reply: `❌ Error: ${e?.message ?? String(e)}`, action: "error" };
  }
}

const repoOf = (s: PlanStep): string =>
  String(s.params.repo ?? s.params.project_name ?? s.params.site_name ?? "").toLowerCase();

export async function runPlan(steps: PlanStep[], blocks: string[], ctx: RunCtx): Promise<Record<string, any>> {
  const started = Date.now();
  const results: { step: PlanStep; res: Record<string, any> | null; ok: boolean; skipped?: string }[] = [];
  const freshRepos = new Set<string>();
  let stopped: string | null = null;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (stopped) {
      results.push({ step, res: null, ok: false, skipped: stopped });
      continue;
    }
    if (Date.now() - started > DEADLINE_MS) {
      stopped = "time limit — baaki steps alag message me bhejo";
      results.push({ step, res: null, ok: false, skipped: stopped });
      continue;
    }

    let res = await runOne(step, blocks, ctx);
    // Naya bana repo: GitHub ko kuch second lagte hain — "not found" pe chhota retry
    if (freshRepos.has(repoOf(step)) && !stepOk(res) && /not found|404|nahi mila/i.test(String(res.reply || ""))) {
      for (const wait of [800, 1500, 2500]) {
        await sleep(wait);
        res = await runOne(step, blocks, ctx);
        if (stepOk(res) || !/not found|404|nahi mila/i.test(String(res.reply || ""))) break;
      }
    }

    const ok = stepOk(res);
    if (ok && step.cmd === "CREATE_REPO" && res.action === "create_repo") freshRepos.add(String(res.repo || step.params.repo).toLowerCase());
    results.push({ step, res, ok });
    if (!ok) stopped = `Step ${i + 1} fail hua`;
  }

  // ── Ek step wala plan: bilkul single command jaisa response (UI ke rich cards/shortcuts chalte rahein) ──
  if (steps.length === 1 && results[0].res) {
    const r = results[0].res;
    r.source = ctx.source;
    r.action_command = steps[0].cmd;
    return r;
  }

  const lines = results.map((r, i) => {
    const n = i + 1;
    if (r.skipped) return `⏭️ ${n}. ${r.step.summary} — ${r.skipped}`;
    const first = String(r.res?.reply || "").split("\n").find((l) => l.trim() && !/^[*_`]+$/.test(l.trim())) || "";
    const url = r.res?.url ? ` — 🔗 ${r.res.url}` : "";
    if (r.ok) return `✅ ${n}. ${r.step.summary}${url}`;
    return `❌ ${n}. ${r.step.summary}\n   ${first.slice(0, 220)}`;
  });
  const done = results.filter((r) => r.ok).length;
  const allOk = done === steps.length;
  const header = allOk
    ? `📋 **Plan complete — ${steps.length}/${steps.length} steps ho gaye** 🎉`
    : `📋 **Plan adhoora — ${done}/${steps.length} steps hue**`;

  const out: Record<string, any> = {
    reply: `${header}\n\n${lines.join("\n")}`,
    action: allOk ? "plan_done" : "plan_failed",
    source: ctx.source,
    steps: results.map((r) => ({ cmd: r.step.cmd, ok: r.ok, summary: r.step.summary, skipped: !!r.skipped })),
  };

  // Aakhri step deploy tha -> UI ka live deploy terminal chalne do
  const last = results[results.length - 1];
  const la = last?.res?.action;
  if (allOk && last?.res && (la === "vercel_deploy" || la === "vercel_deploy_pending") && last.res.deployment_id) {
    out.action = la;
    out.deployment_id = last.res.deployment_id;
    out.project_name = last.res.project_name;
    out.url = last.res.url;
  }
  return out;
}
