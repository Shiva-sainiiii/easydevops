/**
 * RISK TIERS — har command ka risk level.
 *
 *  read        : sirf dekhna (list/info/status). Kabhi confirm nahi.
 *  write       : kuch banata/badalta hai (repo, file, deploy, env set...). Rules se aaye to seedha chalta hai.
 *  destructive : delete / rollback / merge — hamesha confirm.
 *
 * AI-origin commands (free-form AI fallback) ke liye rule: read ke alawa sab confirm maangte hain.
 * Reason: AI ka output kisi bhi text (jaise repo ki kisi file me chhupi instruction) se prabhavit ho sakta hai
 * (prompt injection) — insaan ka ek tap us risk ko khatam kar deta hai.
 *
 * Pure module — koi import nahi, isliye tests me seedha chalta hai.
 */

export type Risk = "read" | "write" | "destructive";
export type Origin = "rules" | "planner" | "ai";

export const DESTRUCTIVE: ReadonlySet<string> = new Set([
  "DELETE_REPO", "DELETE_FILE", "VERCEL_DELETE_PROJECT", "NETLIFY_DELETE_SITE", "RENDER_DELETE_SERVICE", "VERCEL_ROLLBACK",
  "BULK_DELETE_FILES", "BULK_DELETE_REPOS", "BULK_DELETE_VERCEL_PROJECTS",
  "BULK_DELETE_NETLIFY_SITES", "BULK_DELETE_RENDER_SERVICES",
  "REMOVE_COLLABORATOR", "MERGE_PR", "CLOSE_PR",
]);

export const READ_ONLY: ReadonlySet<string> = new Set([
  "LIST_REPOS", "LIST_FILES", "READ_FILE", "GET_REPO_INFO", "GITHUB_CHECK_STATUS",
  "LIST_COLLABORATORS", "LIST_MY_INVITATIONS", "LIST_SHARED_REPOS", "LIST_BRANCHES",
  "LIST_PRS", "PR_DETAILS", "PR_PREVIEW", "LIST_NOTIFICATIONS",
  "VERCEL_LIST_PROJECTS", "VERCEL_LIST_DEPLOYMENTS", "NETLIFY_LIST_SITES", "NETLIFY_GET_SITE_INFO", "RENDER_LIST_SERVICES",
]);

// "Read" jo secrets/env values dikhate hain — AI-origin me inhe write jaisa treat karte hain
export const SENSITIVE_READ: ReadonlySet<string> = new Set([
  "VERCEL_GET_ENV", "VERCEL_DOWNLOAD_ENV", "NETLIFY_GET_ENV", "RENDER_GET_ENV",
]);

export const WRITE: ReadonlySet<string> = new Set([
  "CREATE_REPO", "CREATE_FILE", "EDIT_FILE", "GENERATE_RENDER_YAML", "CODE_GENERATE",
  "INVITE_COLLABORATOR", "CANCEL_INVITE", "ACCEPT_INVITATION", "DECLINE_INVITATION",
  "CREATE_BRANCH", "COMMENT_PR", "MARK_NOTIFICATIONS_READ", "FORK_REPO", "CREATE_FORK_PR", "CREATE_PR",
  "VERCEL_IMPORT_REPO", "VERCEL_DEPLOY", "VERCEL_SET_ENV",
  "NETLIFY_DEPLOY", "NETLIFY_SET_ENV",
  "RENDER_CREATE_SERVICE", "RENDER_SET_ENV", "RENDER_DEPLOY",
  ...SENSITIVE_READ,
]);

export function riskOf(cmd: string): Risk {
  if (DESTRUCTIVE.has(cmd)) return "destructive";
  if (READ_ONLY.has(cmd)) return "read";
  return "write"; // unknown command = write maano (safe side)
}

export function isKnownCommand(cmd: string): boolean {
  return DESTRUCTIVE.has(cmd) || READ_ONLY.has(cmd) || WRITE.has(cmd);
}

/** Kya ye command chalane se pehle user ka "Haan" chahiye? */
export function needsConfirmation(cmd: string, origin: Origin): boolean {
  const risk = riskOf(cmd);
  if (risk === "destructive") return true;
  if (origin === "ai" && risk !== "read") return true;
  return false;
}
