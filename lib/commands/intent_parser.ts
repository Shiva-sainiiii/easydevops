/**
 * INTENT PARSER — user ke raw message pe regex matching (Python se faithful port).
 *
 * Python `re` -> JS RegExp farq jo yahan handle kiye gaye:
 *  - Python `\w` Unicode hai, JS `\w` sirf ASCII  -> pyRegex() `\w` ko [\p{L}\p{N}_] bana deta hai
 *  - Python `\b` Unicode-aware, JS `\b` ASCII      -> pyRegex() `\b` ko lookaround se replace karta hai
 *  - flags: hamesha "u" (+ "i" jahan re.IGNORECASE tha)
 * Patterns bilkul Python wale raw strings hain (String.raw), sirf conversion pyRegex se hota hai.
 */

const WCHARS = String.raw`\p{L}\p{N}_`;
const W = `[${WCHARS}]`;
const WORD_BOUNDARY = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;

/** Python-style pattern string -> JS RegExp (unicode-aware \w aur \b). */
export function pyRegex(pattern: string, flags = ""): RegExp {
  let out = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      const n = pattern[i + 1];
      if (n === "w") out += inClass ? WCHARS : W;
      else if (n === "b" && !inClass) out += WORD_BOUNDARY;
      else out += c + (n ?? "");
      i++;
      continue;
    }
    if (c === "[" && !inClass) inClass = true;
    else if (c === "]" && inClass) inClass = false;
    out += c;
  }
  return new RegExp(out, "u" + flags);
}

export const SLUG = String.raw`[\w][\w.\-]*`;
export const PATH = String.raw`[\w][\w./\-]*`;
// `repo` ya `owner/repo` (collaboration). Non-capturing, isliye group numbers nahi badalte.
export const REPO_REF = String.raw`[\w][\w.\-]*(?:/[\w][\w.\-]*)?`;
// GitHub username (hyphen allowed, dot nahi)
export const GH_USER = String.raw`[a-z0-9][a-z0-9\-]*`;
// Invite ke saath permission ka lafz (admin jaanbujh ke nahi)
// Branch naam (slash allowed, jaise feature/login). Note: matching lowercase message pe hoti hai.
export const BRANCH_NAME = String.raw`[\w][\w.\-/]*`;
export const PERM_WORDS = String.raw`(?:pull|read|triage|push|write|maintain)`;
export const CODEGEN_VERBS = String.raw`(?:build|banao|bana\s*do|create|add|fix|karo|update|change|edit|refactor|improve)`;
export const CODEGEN_INSPECT_VERBS_RE = String.raw`\b(?:understand|explain|review|check|what\s+is|kya\s+hai|samjhao|samajh|batao|dekho|dekh)\b`;
export const CODEGEN_STRONG_CHANGE_VERBS_RE = String.raw`\b(?:fix|edit|update|change|add|remove|delete|refactor|debug|improve|build|create|banao|bana|isme|ismein|iska|isko)\b`;
export const CODEGEN_GENERIC_DO_RE = String.raw`\b(?:karo|kar\s*do)\b`;

export const NO_ARG_COMMANDS = new Set(["LIST_REPOS", "VERCEL_LIST_PROJECTS", "NETLIFY_LIST_SITES", "RENDER_LIST_SERVICES"]);

type M = RegExpExecArray;
const g = (m: M, i: number): string | null => (m[i] === undefined ? null : m[i]);
const r = String.raw;

type Rule = [string, string[], (m: M) => Record<string, any>];

/** Invite ke message me se permission nikalo (read->pull, write->push); na ho to null (executor default push). */
function invitePerm(m: M): string | null {
  const t = String(m.input || "");
  const hit = /\b(pull|read|triage|push|write|maintain)\b/.exec(t);
  if (!hit) return null;
  return hit[1] === "read" ? "pull" : hit[1] === "write" ? "push" : hit[1];
}

export const INTENT_RULES: Rule[] = [
  // ── COLLABORATION (sabse upar: "list collaborators of repo X" LIST_REPOS me na phanse) ──
  // "..repo" ke baad "as/with <perm> access" optional; "admin" jaanbujh ke nahi.
  ["INVITE_COLLABORATOR", [
    r`^invite\s+@?(${GH_USER})\s+(?:to|in|into)\s+(?:repo(?:sitory)?\s+)?(${REPO_REF})(?:\s+(?:as|with)\s+(?:a\s+)?${PERM_WORDS}(?:\s+access)?)?$`,
    r`^(?:add)\s+@?(${GH_USER})\s+as\s+(?:a\s+)?collaborator\s+(?:to|in|on|into)\s+(?:repo(?:sitory)?\s+)?(${REPO_REF})(?:\s+(?:as|with)\s+(?:a\s+)?${PERM_WORDS}(?:\s+access)?)?$`,
  ], (m) => ({ username: g(m, 1), repo: g(m, 2), permission: invitePerm(m) })],

  ["INVITE_COLLABORATOR", [
    r`^@?(${GH_USER})\s+ko\s+(${REPO_REF})\s+(?:mein|me)\s+(?:collaborator\s+(?:banao|bana\s*do|add\s+(?:karo|kar\s*do|kardo))|invite\s+(?:karo|kar\s*do|kardo|bhejo))(?:\s+(?:${PERM_WORDS})\s+access\s+ke\s+(?:saath|sath))?$`,
  ], (m) => ({ username: g(m, 1), repo: g(m, 2), permission: invitePerm(m) })],

  ["INVITE_COLLABORATOR", [
    r`^(${REPO_REF})\s+(?:mein|me)\s+@?(${GH_USER})\s+ko\s+(?:collaborator\s+(?:banao|bana\s*do|add\s+(?:karo|kar\s*do|kardo))|invite\s+(?:karo|kar\s*do|kardo|bhejo))(?:\s+(?:${PERM_WORDS})\s+access\s+ke\s+(?:saath|sath))?$`,
  ], (m) => ({ repo: g(m, 1), username: g(m, 2), permission: invitePerm(m) })],

  ["LIST_COLLABORATORS", [
    r`^(?:list|show|dikhao|dikha)\s+(?:all\s+|sare\s+)?collaborators?\s+(?:of|for|in)\s+(?:repo(?:sitory)?\s+)?(${REPO_REF})$`,
    r`^who\s+(?:has|have)\s+access\s+(?:to|of)\s+(?:repo(?:sitory)?\s+)?(${REPO_REF})$`,
    r`^(${REPO_REF})\s+(?:ke|ki|ka)\s+collaborators?\s+(?:dikhao|dikha|list|batao|show)(?:\s+(?:karo|kar\s*do))?$`,
  ], (m) => ({ repo: g(m, 1) })],

  ["CANCEL_INVITE", [
    r`^(?:cancel|withdraw)\s+invite\s+(?:of\s+|for\s+)?@?(${GH_USER})\s+(?:from|in|of|for)\s+(?:repo(?:sitory)?\s+)?(${REPO_REF})$`,
    r`^(?:cancel|withdraw)\s+@?(${GH_USER})(?:'s|s)?\s+invite\s+(?:from|in|of|for)\s+(?:repo(?:sitory)?\s+)?(${REPO_REF})$`,
  ], (m) => ({ username: g(m, 1), repo: g(m, 2) })],

  ["CANCEL_INVITE", [
    r`^(${REPO_REF})\s+(?:se|me|mein)\s+@?(${GH_USER})\s+ka\s+invite\s+(?:cancel|hatao|hata\s*do|wapas\s*lo)(?:\s+(?:karo|kar\s*do))?$`,
  ], (m) => ({ repo: g(m, 1), username: g(m, 2) })],

  // Bare "remove X from repo" jaanbujh ke nahi (file/collaborator confuse ho jate) — wo AI fallback
  // sambhalta hai; yahan "collaborator"/"access" lafz zaroori hai.
  ["REMOVE_COLLABORATOR", [
    r`^(?:remove|kick)\s+@?(${GH_USER})\s+(?:as\s+)?(?:a\s+)?collaborator\s+(?:from|of)\s+(?:repo(?:sitory)?\s+)?(${REPO_REF})$`,
    r`^(?:remove|kick)\s+collaborator\s+@?(${GH_USER})\s+(?:from|of)\s+(?:repo(?:sitory)?\s+)?(${REPO_REF})$`,
    r`^(?:remove|revoke)\s+@?(${GH_USER})(?:'s)?\s+access\s+(?:from|to|of)\s+(?:repo(?:sitory)?\s+)?(${REPO_REF})$`,
  ], (m) => ({ username: g(m, 1), repo: g(m, 2) })],

  ["REMOVE_COLLABORATOR", [
    r`^(${REPO_REF})\s+(?:se|me|mein)\s+@?(${GH_USER})\s+ko\s+collaborator(?:\s+(?:list\s+)?se)?\s+(?:hata(?:o|\s*do)|nikalo|remove)(?:\s+(?:karo|kar\s*do))?$`,
    r`^(${REPO_REF})\s+(?:se|me|mein)\s+@?(${GH_USER})\s+ka\s+access\s+(?:hata(?:o|\s*do)|band\s+(?:karo|kar\s*do)|remove)(?:\s+(?:karo|kar\s*do))?$`,
  ], (m) => ({ repo: g(m, 1), username: g(m, 2) })],

  // ── FRIEND SIDE (Phase 2): invitations + shared repos ──
  ["LIST_MY_INVITATIONS", [
    r`^(?:my|mere|meri|mujhe\s+aaye)\s+(?:pending\s+)?(?:repo(?:sitory)?\s+)?invit(?:e|ation)s?$`,
    r`^(?:show|list|check|dikhao|dikha)\s+(?:my\s+|mere\s+)?(?:pending\s+)?(?:repo(?:sitory)?\s+)?invit(?:e|ation)s?$`,
    r`^(?:pending\s+)?(?:repo(?:sitory)?\s+)?invit(?:e|ation)s?\s+(?:dikhao|dikha|batao|list|show)$`,
    r`^koi\s+invit(?:e|ation)\s+(?:aaya|aya|aayi)(?:\s+hai)?$`,
  ], () => ({})],

  ["ACCEPT_INVITATION", [
    r`^accept\s+(?:the\s+)?(?:repo(?:sitory)?\s+)?(?:invite|invitation)\s+(?:to\s+|from\s+|for\s+|of\s+)?(${REPO_REF})$`,
    r`^accept\s+(${REPO_REF})\s+(?:invite|invitation)$`,
    r`^(${REPO_REF})\s+(?:ka|ki)\s+(?:invite|invitation)\s+(?:accept|manzoor)\s*(?:karo|kar\s*do|kardo)?$`,
  ], (m) => ({ repo: g(m, 1) })],

  ["DECLINE_INVITATION", [
    r`^(?:decline|reject|ignore)\s+(?:the\s+)?(?:repo(?:sitory)?\s+)?(?:invite|invitation)\s+(?:to\s+|from\s+|for\s+|of\s+)?(${REPO_REF})$`,
    r`^(?:decline|reject|ignore)\s+(${REPO_REF})\s+(?:invite|invitation)$`,
    r`^(${REPO_REF})\s+(?:ka|ki)\s+(?:invite|invitation)\s+(?:decline|reject|mana)\s*(?:karo|kar\s*do|kardo)?$`,
  ], (m) => ({ repo: g(m, 1) })],

  ["LIST_SHARED_REPOS", [
    r`^(?:show|list|dikhao|dikha)\s+(?:my\s+|mere\s+)?(?:shared|collaborat(?:ed|ion|or))\s+repos?(?:sitories)?$`,
    r`^(?:shared|collaborat(?:ed|ion))\s+repos?(?:sitories)?(?:\s+(?:dikhao|dikha|batao|list|show))?$`,
    r`^(?:mere\s+saath|mujhe)\s+share\s+(?:kiye|kiya)\s+(?:gaye\s+)?repos?$`,
    r`^repos?\s+shared\s+with\s+me$`,
  ], () => ({})],

  // ── BRANCHES (Phase 3) — CODE_GENERATE/CREATE_REPO se pehle, warna "create branch x in repo" unme phans jata ──
  ["CREATE_BRANCH", [
    r`^(?:create|make|new|banao|bana\s*do)\s+(?:a\s+|ek\s+)?branch\s+(${BRANCH_NAME})(?:\s+from\s+(${BRANCH_NAME}))?\s+(?:in|of|for|on)\s+(?:repo(?:sitory)?\s+)?(${REPO_REF})$`,
  ], (m) => ({ repo: g(m, 3), branch: g(m, 1), base: g(m, 2) })],

  ["CREATE_BRANCH", [
    r`^(${REPO_REF})\s+(?:mein|me)\s+(?:branch|nayi\s+branch)\s+(${BRANCH_NAME})\s+(?:banao|bana\s*do|create)(?:\s+(?:karo|kar\s*do))?$`,
  ], (m) => ({ repo: g(m, 1), branch: g(m, 2), base: null })],

  ["LIST_BRANCHES", [
    r`^(?:list|show|dikhao|dikha)\s+(?:all\s+|sare\s+)?branch(?:es)?\s+(?:of|for|in|from)\s+(?:repo(?:sitory)?\s+)?(${REPO_REF})$`,
    r`^(${REPO_REF})\s+(?:ki|ke)\s+branch(?:es)?\s+(?:dikhao|dikha|list|batao|show)(?:\s+(?:karo|kar\s*do))?$`,
  ], (m) => ({ repo: g(m, 1) })],

  ["LIST_FILES", [
    r`(?:list|sare|show|dikhao|dikha)\s+(?:all\s+)?files?\s+(?:in|of|from)\s+(${REPO_REF})`,
  ], (m) => ({ repo: g(m, 1), path: "" })],

  ["READ_FILE", [
    r`(?:read|padh|padho|show|dikhao|dikha|open|kholo)\s+(?:the\s+)?file\s+(${PATH})\s+(?:from|in|of)\s+(${REPO_REF})`,
  ], (m) => ({ repo: g(m, 2), path: g(m, 1) })],

  ["DELETE_FILE", [
    r`(?:delete|uda|udado|hata|hatao|remove)\s+(?:the\s+)?file\s+(${PATH})\s+(?:from|in|of)\s+(${REPO_REF})`,
  ], (m) => ({ repo: g(m, 2), path: g(m, 1) })],

  ["EDIT_FILE", [
    r`(?:edit|change|update|badlo|badal\s*do|modify)\s+(?:the\s+)?file\s+(${PATH})\s+(?:in|of)\s+(${REPO_REF})`,
  ], (m) => ({ repo: g(m, 2), path: g(m, 1) })],

  ["CREATE_FILE", [
    r`(?:create|bnao|banao|new|naya)\s+(?:a\s+)?file\s+(${PATH})\s+(?:in|inside|for)\s+(${REPO_REF})`,
  ], (m) => ({ repo: g(m, 2), path: g(m, 1) })],

  ["CREATE_REPO", [
    r`(?:create|bnao|banao|naya|new)\s+(?:a\s+|ek\s+)?repo(?:sitory)?\s+` +
      r`(?:called\s+|named\s+)?(?:bnao|banao|bana\s*do)\s+(${SLUG})`,
    r`(?:create|bnao|banao|naya|new)\s+(?:a\s+|ek\s+)?repo(?:sitory)?\s+(?:called\s+|named\s+)?(${SLUG})`,
    r`repo(?:sitory)?\s+(${SLUG})\s+(?:create|bnao|banao|bana(?:\s*do)?)\s*(?:karo|kar\s*do)?$`,
  ], (m) => ({ repo: g(m, 1) })],

  ["DELETE_REPO", [
    r`(?:delete|uda|udado|hata|hatao|remove)\s+(?:the\s+)?repo(?:sitory)?\s+(${REPO_REF})`,
    r`repo(?:sitory)?\s+(${REPO_REF})\s+(?:delete|uda(?:\s*do)?|hata(?:o|\s*do)?|remove)\s*(?:karo|kar\s*do)?$`,
  ], (m) => ({ repo: g(m, 1) })],

  // CI / GitHub Actions check status. ref optional (group 2). "on branch|on|branch" mein
  // do-word form pehle try hota hai (greedy SLUG ki wajah se).
  ["GITHUB_CHECK_STATUS", [
    r`(?:check|ci|build)\s+status\s+(?:of|for)\s+(${REPO_REF})(?:\s+(?:on\s+branch|on|branch)\s+(${SLUG}))?`,
    r`(${REPO_REF})\s+(?:ki\s+)?(?:(${SLUG})\s+branch\s+(?:ki\s+)?)?(?:ci\s+)?status\s+(?:dikhao|dikha|check\s+karo|batao)`,
    r`(${REPO_REF})\s+(?:ke\s+)?(?:checks?|actions?)\s+(?:dikhao|dikha|show)(?:\s+(?:on\s+branch|on|branch)\s+(${SLUG}))?`,
  ], (m) => ({ repo: g(m, 1), ref: g(m, 2) })],

  ["GET_REPO_INFO", [
    // netlify/render par negative lookahead: "info about netlify site X" yahan na phanse
    r`(?:info|information|details)\s+(?:about|of|for)\s+(?:repo\s+)?(?!netlify\b|render\b)(${REPO_REF})`,
    r`repo\s+info\s+(${REPO_REF})`,
    r`(${REPO_REF})\s+ki\s+info\s+(?:do|dikhao|dikha)`,
  ], (m) => ({ repo: g(m, 1) })],

  ["LIST_REPOS", [
    r`(?:list|sare|mere|show|dikhao|dikha)\s+.*\brepos?\b`,
    r`^(?:repos?|my\s+repos?)$`,
  ], () => ({})],

  // ── VERCEL ──
  ["VERCEL_LIST_PROJECTS", [
    r`(?:list|sare|show|dikhao|dikha)\s+.*vercel.*projects?\b`,
    r`^vercel\s+projects?$`,
  ], () => ({})],

  ["VERCEL_IMPORT_REPO", [
    r`(?:import|connect)\s+(${SLUG})\s+(?:to|pe|on|with)\s+vercel`,
  ], (m) => ({ repo: g(m, 1) })],

  ["VERCEL_DEPLOY", [
    r`deploy\s+(${SLUG})\s+(?:to|pe|on)\s+vercel`,
  ], (m) => ({ project_name: g(m, 1) })],

  ["VERCEL_DELETE_PROJECT", [
    r`(?:delete|uda|hata)\s+vercel\s+project\s+(${SLUG})`,
  ], (m) => ({ project_name: g(m, 1) })],

  ["VERCEL_ROLLBACK", [
    // Order zaroori hai: verb-final Hinglish pehle, phir verb-first; sab start-anchored.
    r`^(${SLUG})\s+ko\s+rollback\s+(?:karo|kar\s*do)\s+to\s+([a-zA-Z0-9_-]+)$`,
    r`^(${SLUG})\s+(?:ko\s+)?(?:pichli\s+version\s+pe\s+|previous\s+version\s+pe\s+)rollback\s*(?:karo|kar\s*do)?$`,
    r`^(${SLUG})\s+ko\s+rollback\s+(?:karo|kar\s*do)$`,
    r`^(${SLUG})\s+rollback\s+kar\s*do$`,
    r`^rollback\s+(${SLUG})\s+to\s+(?:previous|last|pichli)\s+(?:version|deployment)$`,
    r`^rollback\s+(${SLUG})\s+to\s+([a-zA-Z0-9_-]+)$`,
    r`^rollback\s+(${SLUG})$`,
    r`^(?:revert|undo)\s+(${SLUG})\s+(?:deploy|deployment)$`,
  ], (m) => (m.length - 1 > 1 && g(m, 2) ? { project_name: g(m, 1), deployment_id: g(m, 2) } : { project_name: g(m, 1) })],

  ["VERCEL_LIST_DEPLOYMENTS", [
    r`(${SLUG})\s+(?:ki\s+)?deployments?\s+(?:list|dikhao|dikha|show)`,
    r`(?:list|show|dikhao|dikha)\s+.*deployments?\s+(?:for|of)\s+(${SLUG})`,
  ], (m) => ({ project_name: g(m, 1) })],

  // Env DOWNLOAD (.env file, asli values). GET_ENV se pehle rakha hai.
  ["VERCEL_DOWNLOAD_ENV", [
    r`(?:download|export|nikal|nikalo|de\s*do|dedo)\s+.*env(?:ironment)?(?:\s+(?:vars?|variables?|file))?\s+(?:for|of|from|ka|ki|ke)\s+(?:vercel\s+)?(?:project\s+)?(${SLUG})`,
    r`(?:download|export|nikal|nikalo)\s+(?:vercel\s+)?(?:project\s+)?(${SLUG})\s+(?:ka\s+|ki\s+|ke\s+)?\.?env`,
    r`(?:vercel\s+)?(?:project\s+)?(${SLUG})\s+(?:ka|ki|ke)\s+\.?env(?:ironment)?(?:\s+(?:vars?|variables?|file))?\s+(?:download|export|nikal|nikalo|chahiye|de\s*do|dedo)`,
  ], (m) => {
    const t = String(m.input || "");
    const envTarget = /\bpreview\b/.test(t) ? "preview" : /\b(?:development|dev)\b/.test(t) ? "development" : "production";
    return { project_name: g(m, 1), env_target: envTarget };
  }],

  ["VERCEL_GET_ENV", [
    r`(?:get|show|dikhao|dikha)\s+.*env(?:ironment)?(?:\s+vars?)?\s+(?:for|of)\s+(${SLUG})\s+.*vercel`,
    r`vercel\s+.*env(?:ironment)?(?:\s+vars?)?\s+(?:for|of)\s+(${SLUG})`,
  ], (m) => ({ project_name: g(m, 1) })],

  ["VERCEL_SET_ENV", [
    r`(?:set|add|update)\s+env\s+(\w+)\s*=\s*(\S+)\s+(?:for|in|on)\s+(${SLUG})\s+.*vercel`,
    r`(?:set|add|update)\s+vercel\s+env\s+(\w+)\s*=\s*(\S+)\s+(?:for|in|on)\s+(${SLUG})`,
  ], (m) => ({ project_name: g(m, 3), key: g(m, 1), value: g(m, 2) })],

  // ── NETLIFY ──
  ["NETLIFY_DEPLOY", [
    r`deploy\s+netlify\s+site\s+(${SLUG})`,
    r`deploy\s+(${SLUG})\s+to\s+netlify`,
    r`(${SLUG})\s+(?:ko\s+)?netlify\s+(?:pe|par)\s+deploy\s+(?:karo|kar\s*do)`,
  ], (m) => ({ site_name: g(m, 1) })],

  ["NETLIFY_LIST_SITES", [
    r`(?:list|sare|show|dikhao|dikha)\s+.*netlify.*sites?\b`,
    r`^netlify\s+sites?$`,
  ], () => ({})],

  ["NETLIFY_DELETE_SITE", [
    r`(?:delete|uda|hata)\s+netlify\s+site\s+(${SLUG})`,
  ], (m) => ({ site_name: g(m, 1) })],

  ["NETLIFY_GET_SITE_INFO", [
    r`(?:info|information|details)\s+(?:about|of|for)\s+netlify\s+site\s+(${SLUG})`,
    r`netlify\s+site\s+info\s+(${SLUG})`,
  ], (m) => ({ site_name: g(m, 1) })],

  ["NETLIFY_GET_ENV", [
    r`(?:get|show|dikhao|dikha)\s+.*env(?:ironment)?(?:\s+vars?)?\s+(?:for|of)\s+(${SLUG})\s+.*netlify`,
    r`netlify\s+.*env(?:ironment)?(?:\s+vars?)?\s+(?:for|of)\s+(${SLUG})`,
  ], (m) => ({ site_name: g(m, 1) })],

  ["NETLIFY_SET_ENV", [
    r`(?:set|add|update)\s+env\s+(\w+)\s*=\s*(\S+)\s+(?:for|in|on)\s+(${SLUG})\s+.*netlify`,
    r`(?:set|add|update)\s+netlify\s+env\s+(\w+)\s*=\s*(\S+)\s+(?:for|in|on)\s+(${SLUG})`,
  ], (m) => ({ site_name: g(m, 3), key: g(m, 1), value: g(m, 2) })],

  // ── RENDER ──
  ["RENDER_CREATE_SERVICE", [
    r`(?:create|bana|banao|bana\s*do|new|naya|deploy)\s+(?:a\s+|ek\s+)?(?:new\s+)?render\s+service\s+(?:for|from|of)\s+(${SLUG})`,
    r`(${SLUG})\s+(?:ka|ke\s+liye)\s+(?:naya\s+)?render\s+service\s+(?:banao|bana\s*do|create)`,
    r`(${SLUG})\s+(?:pe|par|ko)\s+render\s+(?:pe|par)\s+(?:naya\s+)?service\s+(?:banao|bana\s*do|create)`,
  ], (m) => ({ repo: g(m, 1) })],

  ["RENDER_LIST_SERVICES", [
    r`(?:list|sare|show|dikhao|dikha)\s+.*render.*services?\b`,
    r`(?:list|sare|show|dikhao|dikha)\s+.*services?.*render\b`,
    r`^render\s+services?$`,
    r`^services?\s+render$`,
    r`^render\s+(?:ke\s+)?services?\s+(?:dikhao|dikha|show|list)$`,
  ], () => ({})],

  ["RENDER_DELETE_SERVICE", [
    r`(?:delete|uda|udado|hata|hatao|remove)\s+(?:the\s+)?(?:render\s+)?service\s+(${SLUG})`,
  ], (m) => ({ service_id: g(m, 1) })],

  ["RENDER_DELETE_SERVICE", [
    r`(${SLUG})\s+service\s+(?:delete|uda(?:o|\s*do)?|hata(?:o|\s*do)?)\s*(?:karo|kar\s*do)?`,
  ], (m) => ({ service_id: g(m, 1) })],

  ["RENDER_GET_ENV", [
    r`(?:get|show|dikhao|dikha)\s+.*env(?:ironment)?(?:\s+vars?)?\s+(?:for|of)\s+(${SLUG})\s+.*render`,
    r`render\s+.*env(?:ironment)?(?:\s+vars?)?\s+(?:for|of)\s+(${SLUG})`,
  ], (m) => ({ service_id: g(m, 1) })],

  ["RENDER_SET_ENV", [
    r`(?:set|add|update)\s+env\s+(\w+)\s*=\s*(\S+)\s+(?:for|in|on)\s+(${SLUG})\s+.*render`,
    r`(?:set|add|update)\s+render\s+env\s+(\w+)\s*=\s*(\S+)\s+(?:for|in|on)\s+(${SLUG})`,
  ], (m) => ({ service_id: g(m, 3), env_vars: { [g(m, 1) as string]: g(m, 2) } })],

  ["RENDER_DEPLOY", [
    r`deploy\s+(${SLUG})\s+(?:to|pe|on)\s+render`,
  ], (m) => ({ service_id: g(m, 1) })],

  ["GENERATE_RENDER_YAML", [
    r`(?:generate|bana|banao|bana\s*do|create)\s+(?:a\s+|ek\s+)?render\.?ya?ml\s+(?:for|in|of)\s+(${SLUG})`,
    r`(${SLUG})\s+(?:ke\s+liye|ka)\s+render\.?ya?ml\s+(?:generate|bana|banao|bana\s*do)`,
    r`render\.?ya?ml\s+(?:generate|bana|banao|bana\s*do)\s+(?:for|in)\s+(${SLUG})`,
    r`^(${SLUG})\s+(?:ke\s+liye\s+)?(?:blueprint|iac)\s+(?:generate|bana|banao)`,
  ], (m) => ({ repo: g(m, 1) })],

  // ── PHASE 4: notifications / preview / fork ──
  ["MARK_NOTIFICATIONS_READ", [
    r`^(?:mark\s+)?(?:all\s+)?notifications?\s+(?:as\s+)?read$`,
    r`^mark\s+all\s+(?:as\s+)?read$`,
    r`^notifications?\s+(?:clear|saaf)\s*(?:karo|kar\s*do)?$`,
  ], () => ({})],

  ["LIST_NOTIFICATIONS", [
    r`^(?:show|list|dikhao|dikha|check)\s+(?:my\s+|mere\s+)?(?:(all)\s+)?(?:notifications?|activity)$`,
    r`^(?:meri\s+)?(?:(all)\s+)?notifications?\s+(?:dikhao|dikha|batao|show|check\s+karo)$`,
    r`^(?:what'?s\s+new|kya\s+naya\s+hai)$`,
  ], (m) => ({ all: !!g(m, 1) })],

  ["PR_PREVIEW", [
    r`^(?:preview|preview\s+url)\s+(?:of|for)\s+(?:pr|pull\s*request)\s*#?(\d+)\s+(?:in|of|from|on)\s+(?:repo(?:sitory)?\s+)?(${REPO_REF})$`,
    r`^(?:show|get|dikhao)\s+preview\s+(?:of|for)\s+(?:pr|pull\s*request)\s*#?(\d+)\s+(?:in|of|from|on)\s+(?:repo(?:sitory)?\s+)?(${REPO_REF})$`,
  ], (m) => ({ repo: g(m, 2), number: g(m, 1) })],

  ["PR_PREVIEW", [
    r`^(${REPO_REF})\s+(?:ka|ki|ke)\s+(?:pr|pull\s*request)\s*#?(\d+)\s+(?:ka\s+)?preview\s+(?:dikhao|dikha|batao)$`,
  ], (m) => ({ repo: g(m, 1), number: g(m, 2) })],

  ["FORK_REPO", [
    r`^fork\s+(?:the\s+)?(?:repo(?:sitory)?\s+)?(${REPO_REF})$`,
    r`^(${REPO_REF})\s+(?:ko\s+)?fork\s+(?:karo|kar\s*do|kardo)$`,
  ], (m) => ({ repo: g(m, 1) })],

  // Fork se upstream ko PR: "send pr from my-branch to owner/repo [titled ...]" (title original casing me)
  ["CREATE_FORK_PR", [
    r`^(?:send|submit)\s+(?:a\s+)?(?:pr|pull\s*request)\s+from\s+(${BRANCH_NAME})\s+to\s+(${REPO_REF})(?:\s+titled\s+(.+))?$`,
  ], (m) => ({ head: g(m, 1), repo: g(m, 2), title: g(m, 3), base: null })],

  // ── PR WORKFLOW (Phase 3) — CREATE_PR/CODE_GENERATE se pehle ──
  ["LIST_PRS", [
    r`^(?:list|show|dikhao|dikha)\s+(?:(?:all|sare)\s+)?(?:(open|closed|merged)\s+)?(?:prs|pull\s*requests)\s+(?:of|for|in|from)\s+(?:repo(?:sitory)?\s+)?(${REPO_REF})$`,
    r`^(${REPO_REF})\s+(?:ke|ki)\s+(?:(open|closed|merged)\s+)?(?:prs|pull\s*requests)\s+(?:dikhao|dikha|list|batao|show)(?:\s+(?:karo|kar\s*do))?$`,
  ], (m) => {
    const t = String(m.input || "");
    const explicit = [m[1], m[2]].find((x) => x === "open" || x === "closed" || x === "merged");
    const repoRef = m[1] && !["open", "closed", "merged"].includes(m[1]) ? m[1] : m[2] && !["open", "closed", "merged"].includes(m[2]) ? m[2] : null;
    return { repo: repoRef, state: explicit || (/^(?:list|show|dikhao|dikha)\s+(?:all|sare)\s/.test(t) ? "all" : "open") };
  }],

  ["PR_DETAILS", [
    r`^(?:compare|show|view|dikhao|dikha|dekho)\s+(?:the\s+)?(?:pr|pull\s*request)\s*#?(\d+)\s+(?:in|of|from|for|on)\s+(?:repo(?:sitory)?\s+)?(${REPO_REF})$`,
    r`^(?:details?|info)\s+(?:of|for)\s+(?:pr|pull\s*request)\s*#?(\d+)\s+(?:in|of|from|for|on)\s+(?:repo(?:sitory)?\s+)?(${REPO_REF})$`,
  ], (m) => ({ repo: g(m, 2), number: g(m, 1) })],

  ["PR_DETAILS", [
    r`^(${REPO_REF})\s+(?:ka|ki|ke)\s+(?:pr|pull\s*request)\s*#?(\d+)\s+(?:compare|dikhao|dikha|dekho)(?:\s+(?:karo|kar\s*do))?$`,
  ], (m) => ({ repo: g(m, 1), number: g(m, 2) })],

  ["MERGE_PR", [
    r`^merge\s+(?:the\s+)?(?:pr|pull\s*request)\s*#?(\d+)\s+(?:in|of|from|on|for)\s+(?:repo(?:sitory)?\s+)?(${REPO_REF})(?:\s+(?:using|with|via|by)\s+(squash|merge|rebase)(?:\s+(?:merge|commit))?)?(\s+and\s+delete\s+(?:the\s+)?branch)?$`,
  ], (m) => ({ repo: g(m, 2), number: g(m, 1), method: g(m, 3), delete_branch: !!g(m, 4) })],

  ["MERGE_PR", [
    r`^(${REPO_REF})\s+(?:ka|ki|ke|mein|me)\s+(?:pr|pull\s*request)\s*#?(\d+)\s+merge\s+(?:karo|kar\s*do|kardo)$`,
  ], (m) => ({ repo: g(m, 1), number: g(m, 2), method: null, delete_branch: false })],

  ["CLOSE_PR", [
    r`^close\s+(?:the\s+)?(?:pr|pull\s*request)\s*#?(\d+)\s+(?:in|of|from|on|for)\s+(?:repo(?:sitory)?\s+)?(${REPO_REF})$`,
  ], (m) => ({ repo: g(m, 2), number: g(m, 1) })],

  ["CLOSE_PR", [
    r`^(${REPO_REF})\s+(?:ka|ki|ke|mein|me)\s+(?:pr|pull\s*request)\s*#?(\d+)\s+(?:close|band)\s+(?:karo|kar\s*do|kardo)$`,
  ], (m) => ({ repo: g(m, 1), number: g(m, 2) })],

  // Comment ka text original casing me wapas aata hai (parseIntent me)
  ["COMMENT_PR", [
    r`^comment\s+(?:on\s+)?(?:pr|pull\s*request)\s*#?(\d+)\s+(?:in|on|of|for)\s+(?:repo(?:sitory)?\s+)?(${REPO_REF})\s*[:\-]\s*(.+)$`,
  ], (m) => ({ repo: g(m, 2), number: g(m, 1), body: g(m, 3) })],

  // Title ke saath PR (title original casing me)
  ["CREATE_PR", [
    r`^(?:open|create|bana|banao|bana\s*do)\s+(?:a\s+|ek\s+)?(?:pr|pull\s*request)\s+from\s+(${SLUG})(?:\s+to\s+(${SLUG}))?\s+(?:in|for|of)\s+(${REPO_REF})\s+(?:titled|with\s+title)\s+(.+)$`,
  ], (m) => ({ head: g(m, 1), base: g(m, 2), repo: g(m, 3), title: g(m, 4) })],

  // ── CREATE_PR — CODE_GENERATE se pehle (warna "open ... in repo" CODE_GENERATE kha jata) ──
  ["CREATE_PR", [
    r`(?:open|create|bana|banao|bana\s*do)\s+(?:a\s+|ek\s+)?(?:pr|pull\s*request)\s+` +
      r`from\s+(${SLUG})\s+to\s+(${SLUG})\s+(?:in|for|of)\s+(${REPO_REF})`,
  ], (m) => ({ head: g(m, 1), base: g(m, 2), repo: g(m, 3) })],

  ["CREATE_PR", [
    r`(${REPO_REF})\s+(?:mein|me)\s+(${SLUG})\s+se\s+(${SLUG})\s+(?:tak|mein|ke\s+liye)\s+` +
      r`(?:pr|pull\s*request)\s+(?:banao|bana\s*do|create|open)`,
  ], (m) => ({ repo: g(m, 1), head: g(m, 2), base: g(m, 3) })],

  ["CREATE_PR", [
    r`(?:open|create|bana|banao|bana\s*do)\s+(?:a\s+|ek\s+)?(?:pr|pull\s*request)\s+` +
      r`(?:for|from)\s+(${SLUG})\s+(?:in|of)\s+(${REPO_REF})`,
  ], (m) => ({ head: g(m, 1), base: null, repo: g(m, 2) })],

  // ── CODE_GENERATE — jaanbujh ke sabse last (sabse broad patterns) ──
  ["CODE_GENERATE", [
    r`^${CODEGEN_VERBS}\b.*\s+(?:in|mein|me)\s+(${REPO_REF})$`,
    r`^(${REPO_REF})\s+(?:mein|me)\s+.*${CODEGEN_VERBS}\b`,
  ], (m) => ({ repo: g(m, 1) })],
];

export const COMPLEX_KEYWORDS = [
  "likh", "likho", "banao", "banado", "bnado", "code", "html", "css", "js",
  "javascript", "script", "function", "explain", "samjha", "samjhao",
  "kaise", "kyu", "kyun", "kya", "write", "generate", "design", "navbar",
  "component", "snippet", "fix kar", "debug",
];

// Compile cache (pattern string -> RegExp)
const cache = new Map<string, RegExp>();
function rx(pat: string, flags = ""): RegExp {
  const key = flags + "\u0000" + pat;
  let re = cache.get(key);
  if (!re) {
    re = pyRegex(pat, flags);
    cache.set(key, re);
  }
  return re;
}

const REQUIRED_FIELDS = ["repo", "project_name", "site_name", "service_id", "key"];

function rulePlatform(cmd: string): string | null {
  if (cmd.startsWith("VERCEL_")) return "vercel";
  if (cmd.startsWith("RENDER_")) return "render";
  if (cmd.startsWith("NETLIFY_")) return "netlify";
  return null;
}

export function parseIntent(message: string): [string, Record<string, any>] | [null, null] {
  const original = message.trim();
  const lowered = original.toLowerCase();

  // Message jis platform ka naam leta hai, doosre platform ke rules skip
  const mentioned = new Set(
    ["vercel", "render", "netlify"].filter((p) => rx(String.raw`\b${p}\b`).test(lowered))
  );

  for (const [cmd, patterns, extractor] of INTENT_RULES) {
    const rp = rulePlatform(cmd);
    if (rp && mentioned.size > 0 && !mentioned.has(rp)) continue;
    for (const pat of patterns) {
      const m = rx(pat).exec(lowered);
      if (m) {
        let params: Record<string, any>;
        try {
          params = extractor(m);
        } catch {
          continue;
        }
        if (REQUIRED_FIELDS.some((f) => f in params && (params[f] === null || params[f] === undefined || params[f] === ""))) {
          continue;
        }
        // ENV commands: key ka original casing wapas lao (match lowercase pe hua tha)
        if (cmd === "VERCEL_SET_ENV" || cmd === "NETLIFY_SET_ENV") {
          const om = rx(pat, "i").exec(original);
          if (om) params.key = om[1];
        }
        if (cmd === "COMMENT_PR") {
          const om = rx(pat, "i").exec(original);
          if (om && om[3]) params.body = om[3];
        }
        if (cmd === "CREATE_FORK_PR" && params.title) {
          const om = rx(pat, "i").exec(original);
          if (om && om[3]) params.title = om[3];
        }
        if (cmd === "CREATE_PR" && params.title) {
          const om = rx(pat, "i").exec(original);
          if (om && om[4]) params.title = om[4];
        }
        if (cmd === "RENDER_SET_ENV") {
          const om = rx(pat, "i").exec(original);
          if (om && params.env_vars) {
            const firstVal = Object.values(params.env_vars)[0];
            params.env_vars = { [om[1]]: firstVal };
          }
        }
        return [cmd, params];
      }
    }
  }
  return [null, null];
}
