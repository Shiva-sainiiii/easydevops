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
export const CODEGEN_VERBS = String.raw`(?:build|banao|bana\s*do|create|add|fix|karo|update|change|edit|refactor|improve)`;
export const CODEGEN_INSPECT_VERBS_RE = String.raw`\b(?:understand|explain|review|check|what\s+is|kya\s+hai|samjhao|samajh|batao|dekho|dekh)\b`;
export const CODEGEN_STRONG_CHANGE_VERBS_RE = String.raw`\b(?:fix|edit|update|change|add|remove|delete|refactor|debug|improve|build|create|banao|bana|isme|ismein|iska|isko)\b`;
export const CODEGEN_GENERIC_DO_RE = String.raw`\b(?:karo|kar\s*do)\b`;

export const NO_ARG_COMMANDS = new Set(["LIST_REPOS", "VERCEL_LIST_PROJECTS", "NETLIFY_LIST_SITES", "RENDER_LIST_SERVICES"]);

type M = RegExpExecArray;
const g = (m: M, i: number): string | null => (m[i] === undefined ? null : m[i]);
const r = String.raw;

type Rule = [string, string[], (m: M) => Record<string, any>];

export const INTENT_RULES: Rule[] = [
  ["LIST_FILES", [
    r`(?:list|sare|show|dikhao|dikha)\s+(?:all\s+)?files?\s+(?:in|of|from)\s+(${SLUG})`,
  ], (m) => ({ repo: g(m, 1), path: "" })],

  ["READ_FILE", [
    r`(?:read|padh|padho|show|dikhao|dikha|open|kholo)\s+(?:the\s+)?file\s+(${PATH})\s+(?:from|in|of)\s+(${SLUG})`,
  ], (m) => ({ repo: g(m, 2), path: g(m, 1) })],

  ["DELETE_FILE", [
    r`(?:delete|uda|udado|hata|hatao|remove)\s+(?:the\s+)?file\s+(${PATH})\s+(?:from|in|of)\s+(${SLUG})`,
  ], (m) => ({ repo: g(m, 2), path: g(m, 1) })],

  ["EDIT_FILE", [
    r`(?:edit|change|update|badlo|badal\s*do|modify)\s+(?:the\s+)?file\s+(${PATH})\s+(?:in|of)\s+(${SLUG})`,
  ], (m) => ({ repo: g(m, 2), path: g(m, 1) })],

  ["CREATE_FILE", [
    r`(?:create|bnao|banao|new|naya)\s+(?:a\s+)?file\s+(${PATH})\s+(?:in|inside|for)\s+(${SLUG})`,
  ], (m) => ({ repo: g(m, 2), path: g(m, 1) })],

  ["CREATE_REPO", [
    r`(?:create|bnao|banao|naya|new)\s+(?:a\s+|ek\s+)?repo(?:sitory)?\s+` +
      r`(?:called\s+|named\s+)?(?:bnao|banao|bana\s*do)\s+(${SLUG})`,
    r`(?:create|bnao|banao|naya|new)\s+(?:a\s+|ek\s+)?repo(?:sitory)?\s+(?:called\s+|named\s+)?(${SLUG})`,
    r`repo(?:sitory)?\s+(${SLUG})\s+(?:create|bnao|banao|bana(?:\s*do)?)\s*(?:karo|kar\s*do)?$`,
  ], (m) => ({ repo: g(m, 1) })],

  ["DELETE_REPO", [
    r`(?:delete|uda|udado|hata|hatao|remove)\s+(?:the\s+)?repo(?:sitory)?\s+(${SLUG})`,
    r`repo(?:sitory)?\s+(${SLUG})\s+(?:delete|uda(?:\s*do)?|hata(?:o|\s*do)?|remove)\s*(?:karo|kar\s*do)?$`,
  ], (m) => ({ repo: g(m, 1) })],

  // CI / GitHub Actions check status. ref optional (group 2). "on branch|on|branch" mein
  // do-word form pehle try hota hai (greedy SLUG ki wajah se).
  ["GITHUB_CHECK_STATUS", [
    r`(?:check|ci|build)\s+status\s+(?:of|for)\s+(${SLUG})(?:\s+(?:on\s+branch|on|branch)\s+(${SLUG}))?`,
    r`(${SLUG})\s+(?:ki\s+)?(?:(${SLUG})\s+branch\s+(?:ki\s+)?)?(?:ci\s+)?status\s+(?:dikhao|dikha|check\s+karo|batao)`,
    r`(${SLUG})\s+(?:ke\s+)?(?:checks?|actions?)\s+(?:dikhao|dikha|show)(?:\s+(?:on\s+branch|on|branch)\s+(${SLUG}))?`,
  ], (m) => ({ repo: g(m, 1), ref: g(m, 2) })],

  ["GET_REPO_INFO", [
    // netlify/render par negative lookahead: "info about netlify site X" yahan na phanse
    r`(?:info|information|details)\s+(?:about|of|for)\s+(?:repo\s+)?(?!netlify\b|render\b)(${SLUG})`,
    r`repo\s+info\s+(${SLUG})`,
    r`(${SLUG})\s+ki\s+info\s+(?:do|dikhao|dikha)`,
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

  // ── CREATE_PR — CODE_GENERATE se pehle (warna "open ... in repo" CODE_GENERATE kha jata) ──
  ["CREATE_PR", [
    r`(?:open|create|bana|banao|bana\s*do)\s+(?:a\s+|ek\s+)?(?:pr|pull\s*request)\s+` +
      r`from\s+(${SLUG})\s+to\s+(${SLUG})\s+(?:in|for|of)\s+(${SLUG})`,
  ], (m) => ({ head: g(m, 1), base: g(m, 2), repo: g(m, 3) })],

  ["CREATE_PR", [
    r`(${SLUG})\s+(?:mein|me)\s+(${SLUG})\s+se\s+(${SLUG})\s+(?:tak|mein|ke\s+liye)\s+` +
      r`(?:pr|pull\s*request)\s+(?:banao|bana\s*do|create|open)`,
  ], (m) => ({ repo: g(m, 1), head: g(m, 2), base: g(m, 3) })],

  ["CREATE_PR", [
    r`(?:open|create|bana|banao|bana\s*do)\s+(?:a\s+|ek\s+)?(?:pr|pull\s*request)\s+` +
      r`(?:for|from)\s+(${SLUG})\s+(?:in|of)\s+(${SLUG})`,
  ], (m) => ({ head: g(m, 1), base: null, repo: g(m, 2) })],

  // ── CODE_GENERATE — jaanbujh ke sabse last (sabse broad patterns) ──
  ["CODE_GENERATE", [
    r`^${CODEGEN_VERBS}\b.*\s+(?:in|mein|me)\s+(${SLUG})$`,
    r`^(${SLUG})\s+(?:mein|me)\s+.*${CODEGEN_VERBS}\b`,
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
