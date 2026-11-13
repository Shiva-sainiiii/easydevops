/**
 * DESTRUCTIVE-ACTION CONFIRMATION — token (command, value, user_id) se bandha hai,
 * isliye ek user ka confirm token doosre user ke naam pe replay nahi ho sakta.
 */
import crypto from "node:crypto";

import { pyJsonDumps, pyRepr, pyStr } from "@/lib/pyjson";

export const DESTRUCTIVE_COMMANDS = new Set([
  "DELETE_REPO", "DELETE_FILE", "VERCEL_DELETE_PROJECT", "NETLIFY_DELETE_SITE", "RENDER_DELETE_SERVICE", "VERCEL_ROLLBACK",
  "BULK_DELETE_FILES", "BULK_DELETE_REPOS", "BULK_DELETE_VERCEL_PROJECTS",
  "BULK_DELETE_NETLIFY_SITES", "BULK_DELETE_RENDER_SERVICES",
]);

export function confirmToken(cmd: string, value: string | null | undefined, userId: number | string): string {
  const raw = `${cmd}:${value || ""}:${userId}`;
  return crypto.createHash("sha256").update(raw, "utf-8").digest("hex").slice(0, 16);
}

const plural = (n: number) => (n !== 1 ? "s" : "");
const listPreview = (arr: string[]) => `${arr.slice(0, 5).join(", ")}${arr.length > 5 ? "…" : ""}`;

export function buildConfirmation(cmd: string, params: Record<string, any>, userId: number | string) {
  const value = pyJsonDumps(params, true);
  const token = confirmToken(cmd, value, userId);
  let actionVerb = "delete"; // confirm prompt ka default headline verb
  let targetDesc: string;
  let warnText: string;

  if (cmd === "DELETE_REPO") {
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
