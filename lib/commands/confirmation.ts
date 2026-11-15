/**
 * DESTRUCTIVE-ACTION CONFIRMATION — token (command, value, user_id) se bandha hai,
 * isliye ek user ka confirm token doosre user ke naam pe replay nahi ho sakta.
 */
import crypto from "node:crypto";

import { config } from "@/lib/config";
import { pyJsonDumps, pyRepr, pyStr } from "@/lib/pyjson";
import { DESTRUCTIVE } from "@/lib/commands/risk";

export const DESTRUCTIVE_COMMANDS = DESTRUCTIVE as Set<string>;

/** Confirm token kitni der valid rehta hai (page khula chhodke chale gaye to purana "Haan" kaam na kare) */
export const CONFIRM_TTL_SECONDS = 15 * 60;

interface TokenOpts {
  now?: number; // ms (tests ke liye)
  secret?: string;
}

function macOf(cmd: string, value: string | null | undefined, userId: number | string, ts: string, secret?: string): string {
  const key = crypto.createHmac("sha256", secret ?? config.FLASK_SECRET_KEY).update("easydevops/confirm/v1").digest();
  return crypto
    .createHmac("sha256", key)
    .update(`${cmd}\n${value || ""}\n${userId}\n${ts}`, "utf-8")
    .digest("hex")
    .slice(0, 40);
}

/**
 * Confirm token = "<time-base36>.<HMAC>". HMAC server ke secret se banta hai (pehle sirf unsalted sha256 tha,
 * jise koi bhi guess/forge kar sakta tha). Token (command, value, user, time) se bandha hai.
 */
export function confirmToken(cmd: string, value: string | null | undefined, userId: number | string, opts: TokenOpts = {}): string {
  const ts = Math.floor((opts.now ?? Date.now()) / 1000).toString(36);
  return `${ts}.${macOf(cmd, value, userId, ts, opts.secret)}`;
}

export type ConfirmCheck = "ok" | "expired" | "bad";

export function verifyConfirmToken(
  token: unknown,
  cmd: string,
  value: string | null | undefined,
  userId: number | string,
  opts: TokenOpts = {}
): ConfirmCheck {
  if (typeof token !== "string") return "bad";
  const m = /^([0-9a-z]{1,10})\.([0-9a-f]{40})$/.exec(token);
  if (!m) return "bad";
  const expected = macOf(cmd, value, userId, m[1], opts.secret);
  const a = Buffer.from(m[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return "bad";
  const age = Math.floor((opts.now ?? Date.now()) / 1000) - parseInt(m[1], 36);
  if (age < 0 || age > CONFIRM_TTL_SECONDS) return "expired";
  return "ok";
}

const plural = (n: number) => (n !== 1 ? "s" : "");
const listPreview = (arr: string[]) => `${arr.slice(0, 5).join(", ")}${arr.length > 5 ? "…" : ""}`;

export function buildConfirmation(cmd: string, params: Record<string, any>, userId: number | string) {
  const value = pyJsonDumps(params, true);
  const token = confirmToken(cmd, value, userId);
  let actionVerb = "delete"; // confirm prompt ka default headline verb
  let targetDesc: string;
  let warnText: string;
  let headlineOverride: string | null = null;

  if (cmd === "MERGE_PR") {
    actionVerb = "merge";
    const method = pyStr(params.method || "squash");
    headlineOverride = `PR #${pyStr(params.number)} ko repo \`${pyStr(params.repo)}\` me merge karne wala hu (\`${method}\`).`;
    targetDesc = "";
    warnText =
      "Changes base branch me chale jayenge" +
      (params.delete_branch ? " aur PR ki branch delete ho jayegi" : "") +
      ". Merge wapas nahi hota (sirf naya revert PR bana sakte ho).";
  } else if (cmd === "CLOSE_PR") {
    actionVerb = "close";
    headlineOverride = `PR #${pyStr(params.number)} ko repo \`${pyStr(params.repo)}\` me close karne wala hu.`;
    targetDesc = "";
    warnText = "PR merge nahi hoga. Baad me GitHub pe reopen kar sakte ho.";
  } else if (cmd === "REMOVE_COLLABORATOR") {
    // confirm_verb "delete" hi rehta hai (frontend button ka label wahi se banta hai)
    headlineOverride = `\`@${pyStr(params.username)}\` ko repo \`${pyStr(params.repo)}\` se hatane wala hu.`;
    targetDesc = "";
    warnText = "Uska access turant band ho jayega. Wapas access dene ke liye naya invite bhejna padega.";
  } else if (cmd === "DELETE_REPO") {
    targetDesc = `GitHub repo \`${pyStr(params.repo)}\``;
    warnText = "Ye permanently delete ho jayega — saara code, history, sab kuch. Wapas nahi aayega.";
  } else if (cmd === "DELETE_FILE") {
    targetDesc = `\`${pyStr(params.path)}\` in repo \`${pyStr(params.repo)}\``;
    warnText = "Ye file repo se permanently hat jayegi.";
  } else if (cmd === "VERCEL_DELETE_PROJECT") {
    targetDesc = `Vercel project \`${pyStr(params.project_name)}\``;
    warnText = "Vercel project aur uski saari deployments delete ho jayengi (GitHub repo safe rahega).";
  } else if (cmd === "NETLIFY_DELETE_SITE") {
    targetDesc = `Netlify site \`${pyStr(params.site_name)}\``;
    warnText = "Netlify site aur uski saari deployments delete ho jayengi (GitHub repo safe rahega).";
  } else if (cmd === "RENDER_DELETE_SERVICE") {
    targetDesc = `Render service \`${pyStr(params.service_id)}\``;
    warnText = "Service permanently delete ho jayegi — logs, deploy history, sab kuch. Wapas nahi aayega.";
  } else if (cmd === "VERCEL_ROLLBACK") {
    actionVerb = "rollback";
    const depDesc = params.deployment_id
      ? ` deployment \`${pyStr(params.deployment_id)}\``
      : " pichli production deployment";
    targetDesc = `Vercel project \`${pyStr(params.project_name)}\``;
    warnText =
      `Live traffic${depDesc} pe switch ho jayega — abhi ki production deployment se hat jayega. ` +
      `Naye pushes bhi tab tak auto-deploy nahi honge jab tak wapas promote na karo.`;
  } else if (cmd === "BULK_DELETE_FILES") {
    const paths: string[] = params.paths ?? [];
    targetDesc = `${paths.length} file${plural(paths.length)} in repo \`${pyStr(params.repo)}\``;
    warnText = "Ye saari files repo se permanently hat jayengi. Wapas nahi aayengi.";
  } else if (cmd === "BULK_DELETE_REPOS") {
    const repos: string[] = params.repos ?? [];
    targetDesc = `${repos.length} GitHub repo${plural(repos.length)} (\`${listPreview(repos)}\`)`;
    warnText = "Ye saare permanently delete ho jayenge — saara code, history, sab kuch. Wapas nahi aayenge.";
  } else if (cmd === "BULK_DELETE_VERCEL_PROJECTS") {
    const projects: string[] = params.projects ?? [];
    targetDesc = `${projects.length} Vercel project${plural(projects.length)} (\`${listPreview(projects)}\`)`;
    warnText = "Ye saare Vercel projects aur unki deployments delete ho jayengi (GitHub repos safe rahenge).";
  } else if (cmd === "BULK_DELETE_NETLIFY_SITES") {
    const sites: string[] = params.sites ?? [];
    targetDesc = `${sites.length} Netlify site${plural(sites.length)} (\`${listPreview(sites)}\`)`;
    warnText = "Ye saari Netlify sites aur unki deployments delete ho jayengi (GitHub repos safe rahenge).";
  } else if (cmd === "BULK_DELETE_RENDER_SERVICES") {
    const services: string[] = params.services ?? [];
    targetDesc = `${services.length} Render service${plural(services.length)} (\`${listPreview(services)}\`)`;
    warnText = "Ye saari services permanently delete ho jayengi — logs, deploy history, sab kuch. Wapas nahi aayengi.";
  } else {
    targetDesc = pyRepr(params);
    warnText = "Ye action wapas nahi ho sakta.";
  }

  const headline =
    headlineOverride !== null ? headlineOverride :
    actionVerb === "delete" ? `${targetDesc} delete karne wala hu.` : `${targetDesc} ko rollback karne wala hu.`;

  return {
    reply: `⚠️ **Pakka?**\n\n${headline}\n\n${warnText}`,
    action: "confirm_required",
    pending_command: cmd,
    pending_value: value,
    confirm_token: token,
    confirm_verb: actionVerb,
    source: "direct",
  };
}

// ── Multi-step PLAN ka confirm (jab plan me koi destructive step ho) ──
const redactLong = (v: any): any => (typeof v === "string" && v.length > 80 ? `<${v.length} chars>` : v);

export function buildPlanConfirmation(
  steps: { cmd: string; summary: string }[],
  value: string,
  userId: number | string
) {
  const lines = steps.map((s, i) => `${i + 1}. ${DESTRUCTIVE.has(s.cmd) ? "⚠️ " : ""}${s.summary}`);
  const risky = steps.filter((s) => DESTRUCTIVE.has(s.cmd)).length;
  return {
    reply:
      `📋 **${steps.length} steps ka plan:**\n\n${lines.join("\n")}\n\n` +
      `⚠️ Isme ${risky} step risky hai (delete / rollback / merge). Chalau? Saare steps ek ke baad ek chalenge.`,
    action: "confirm_required",
    pending_command: "PLAN",
    pending_value: value,
    confirm_token: confirmToken("PLAN", value, userId),
    confirm_verb: "run",
    source: "direct",
  };
}

// ── AI-suggested (non-destructive) action ka confirm: AI ka output bina tap ke nahi chalta ──
export function buildAiConfirmation(cmd: string, params: Record<string, any>, userId: number | string) {
  const value = pyJsonDumps(params, true);
  const preview = Object.entries(params)
    .map(([k, v]) => `${k}: ${pyStr(redactLong(v))}`)
    .join(", ");
  return {
    reply: `🤖 AI ne ye action suggest kiya hai:\n\n\`${cmd}\` ${preview ? `(${preview})` : ""}\n\nChalau?`,
    action: "confirm_required",
    pending_command: cmd,
    pending_value: value,
    confirm_token: confirmToken(cmd, value, userId),
    confirm_verb: "run",
    source: "ai",
  };
}
