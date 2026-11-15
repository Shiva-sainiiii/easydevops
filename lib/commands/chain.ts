/**
 * CHAIN — ek message me kai kaam (multi-step) ko RULES se todna. 0 AI tokens.
 *
 * Problem: "Create a repo name practice and add index.html with <code>" me regex sirf pehle 4 lafz
 * pakad ke ek hi command chala deta tha, baaki message ignore ho jata tha.
 *
 * Ab flow:
 *   1. extractBlocks()   : pasted code (``` fence / <!doctype..</html> / code-runs) ko {{BLOCK_n}} se badal do.
 *                          Code AI ko kabhi nahi jata -> tokens bachte hain aur code badalta nahi.
 *   2. splitClauses()    : "and add", "aur", "phir", "then", newline, "1." jaise connectors pe kaam alag karo
 *                          (sirf tab jab agla lafz koi action verb ho — "invite a and b" nahi tootta).
 *   3. resolveClause()   : har clause ko regex rules se command banao; "usi repo me", "isko deploy karo" jaise
 *                          context (pichla repo) bhi rules se resolve hota hai.
 *   4. Sab clauses resolve ho gaye -> kind "chain" (0 AI). Warna kind "needs_ai" -> tab hi AI planner.
 *
 * Pure module: sirf ./intent_parser aur ./risk import karta hai, isliye tests me seedha chalta hai.
 */
import { AI_ASSISTED_COMMANDS, parseIntentEx, type IntentMatch } from "./intent_parser";
import { DESTRUCTIVE } from "./risk";

export interface PlanStep {
  cmd: string;
  params: Record<string, any>;
  /** Hinglish one-liner (checklist me dikhta hai) */
  summary: string;
  /** AI se content/code banwana ho to (CREATE_FILE bina content, CODE_GENERATE) uska instruction */
  instruction?: string;
  origin: "rules" | "planner";
}

export const MAX_STEPS = 8;
/** Regex match ke baad itne (ya zyada) alag lafz bache hon to message "partial match" maana jata hai. */
export const PARTIAL_WORDS = 6;

// ════════════════════════════════════════════════════════════════
// 1. BLOCKS — pasted code ko placeholder se badlo
// ════════════════════════════════════════════════════════════════
export const BLOCK_RE_G = /\{\{BLOCK_(\d+)\}\}/g;
const BLOCK_TEST = /\{\{BLOCK_\d+\}\}/;
const ph = (n: number) => `{{BLOCK_${n}}}`;

const LIST_MARK = /^\s*(?:[-*•]|\d+[.)])\s/;
const codeyLine = (l: string): boolean =>
  (/^(?:\s{2,}|\t)\S/.test(l) && !LIST_MARK.test(l)) ||
  /[{};]\s*$/.test(l) ||
  /^\s*(?:import|from|def|class|function|const|let|var|return|#include|<\/?[a-z!][^>]*>)/i.test(l);

function stashCodeRuns(text: string, stash: (c: string) => string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!codeyLine(lines[i])) {
      out.push(lines[i++]);
      continue;
    }
    // run: codey ya khaali lines; end codey line pe
    let j = i;
    let lastCodey = i;
    let codeyCount = 0;
    while (j < lines.length && (codeyLine(lines[j]) || lines[j].trim() === "")) {
      if (codeyLine(lines[j])) {
        lastCodey = j;
        codeyCount++;
      }
      j++;
    }
    if (codeyCount >= 4) {
      out.push(stash(lines.slice(i, lastCodey + 1).join("\n")));
      i = lastCodey + 1;
    } else {
      out.push(lines[i++]);
    }
  }
  return out.join("\n");
}

export function extractBlocks(message: string): { text: string; blocks: string[] } {
  const blocks: string[] = [];
  const stash = (code: string): string => {
    blocks.push(code.replace(/^\s*\n/, "").replace(/\s+$/, ""));
    return ` ${ph(blocks.length)} `;
  };
  let text = message.replace(/\r\n/g, "\n");
  text = text.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_m, c) => stash(c));
  text = text.replace(/<!doctype[\s\S]*?<\/html\s*>/gi, (c) => stash(c));
  text = text.replace(/<html[\s\S]*?<\/html\s*>/gi, (c) => stash(c));
  // adhoora HTML (closing tag nahi) — doctype se end tak
  text = text.replace(/<!doctype[\s\S]*$/i, (c) => stash(c));
  text = stashCodeRuns(text, stash);
  return { text, blocks };
}

/** params ke andar {{BLOCK_n}} ko asli code se badalta hai (deep). Poora-string match pe trailing newline ensure. */
export function fillBlocks<T>(value: T, blocks: string[]): T {
  const fill = (v: any): any => {
    if (typeof v === "string") {
      const whole = /^\s*\{\{BLOCK_(\d+)\}\}\s*$/.exec(v);
      if (whole) {
        const b = blocks[Number(whole[1]) - 1] ?? "";
        return b.endsWith("\n") ? b : b + "\n";
      }
      return v.replace(BLOCK_RE_G, (_m, n) => blocks[Number(n) - 1] ?? "");
    }
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return fill(value);
}

// ════════════════════════════════════════════════════════════════
// 2. CLAUSES — message ko kaam-kaam me todo
// ════════════════════════════════════════════════════════════════
const ACTION = String.raw`(?:create|make|add|build|write|put|upload|push|commit|deploy|import|connect|publish|host|launch|delete|remove|rename|invite|merge|close|open|set|update|edit|change|generate|banao|bana|bnao|bna|likho|likh|dalo|daalo|daal|dal|rollback|fork|list|show|dikhao|dikha|check|accept|decline|cancel|comment|fix|read|download|copy|move)`;

const PRON = String.raw`(?:(?:isko|ise|usko|it|this|that|use)\s+)?`;
const SPLITTERS: RegExp[] = [
  // "A and B(verb)", "A aur phir B", "A & B", "A and then B"
  new RegExp(String.raw`\s*[,;.]?\s+(?:and|aur|&|plus)\s+(?:(?:then|phir|fir|also|bhi)\s+)?(?=${PRON}${ACTION}\b)`, "i"),
  // "A, B(verb)" / "A; then B"
  new RegExp(String.raw`\s*[,;]\s*(?:(?:then|phir|fir)\s+)?(?=${PRON}${ACTION}\b)`, "i"),
  // "A then B", "A phir B", "A uske baad B", "A after that B"
  new RegExp(String.raw`\s+(?:then|phir|fir|uske\s+baad|iske\s+baad|after\s+that|afterwards)\s*,?\s+(?=${PRON}${ACTION}\b)`, "i"),
  // "A. B(verb)"
  new RegExp(String.raw`\s*\.\s+(?=${PRON}${ACTION}\b)`, "i"),
  // "1. A 2. B"
  new RegExp(String.raw`\s+\d+[.)]\s+(?=${PRON}${ACTION}\b)`, "i"),
];

const CONTINUATION = /^(?:ye|yeh|this|these|is|iss|isko|iska|isme|usme|usko|wahi|same|code|content|and\s+(?:put|keep|use))\b/i;
const LEAD_NOISE = /^(?:(?:and|then|phir|fir|also|aur|bhi|please|plz|pls|bhai|yaar|pehle|first|next|finally|lastly|uske\s+baad|iske\s+baad|after\s+that)\b[\s,:-]*)+/i;

export function cleanClause(c: string): string {
  return c
    .trim()
    .replace(LIST_MARK, "")
    .replace(LEAD_NOISE, "")
    .replace(/[\s.;,!]+$/g, "")
    .trim();
}

export function splitClauses(text: string): string[] {
  // placeholder se pehle newline = usi clause ka hissa ("... file with\n{{BLOCK_1}}")
  let t = text.trim().replace(/[ \t]*\n[ \t]*(?=\{\{BLOCK_\d+\}\})/g, " ");
  const rawLines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean);

  // continuation lines ("ye code daal de") pichli line se jodo
  const lines: string[] = [];
  for (const l of rawLines) {
    if (lines.length && CONTINUATION.test(cleanClause(l))) lines[lines.length - 1] += " " + l;
    else lines.push(l);
  }

  const out: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(LIST_MARK, "");
    let parts = [line];
    for (const re of SPLITTERS) parts = parts.flatMap((p) => p.split(re));
    for (const p of parts) {
      const c = cleanClause(p);
      if (c) out.push(c);
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// 3. CLAUSE -> COMMAND (rules)
// ════════════════════════════════════════════════════════════════
export interface Ctx {
  repo: string | null;
  lastPath: string | null;
}

const KNOWN_EXT = new Set(
  ("html htm css scss sass less js mjs cjs jsx ts tsx json md txt py yml yaml xml svg env gitignore sh bash java kt c h cpp go rs php rb " +
    "sql csv ini toml lock vue svelte dart swift cs ejs hbs pug ipynb").split(" ")
);
const TECH_NAMES = /^(?:node|next|vue|react|express|three|d3|chart|nuxt|nest|p5|alpine|ember|backbone|angular|svelte|solid)\.js$/i;
const SPECIAL_FILES = new Set(["dockerfile", "makefile", "procfile", "license", "readme"]);

interface FileTok {
  path: string;
  idx: number;
}

function fileTokens(c: string): FileTok[] {
  const out: FileTok[] = [];
  const re = /(?<![\w./@\-])((?:[\w.\-]+\/)*(?:\.[A-Za-z][\w\-]*|[\w\-]+(?:\.[\w\-]+)*\.[A-Za-z][A-Za-z0-9]{0,9}|Dockerfile|Makefile|Procfile|LICENSE))(?![\w@\-])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(c))) {
    const tok = m[1];
    const base = tok.split("/").pop() as string;
    const ext = base.includes(".") ? (base.split(".").pop() as string).toLowerCase() : "";
    if (TECH_NAMES.test(base)) continue;
    if (/^https?:/i.test(tok)) continue;
    const special = SPECIAL_FILES.has(base.toLowerCase());
    const dotfile = base.startsWith(".") && ext !== "";
    if (!special && !dotfile && !KNOWN_EXT.has(ext)) continue;
    out.push({ path: tok, idx: m.index });
  }
  return out;
}

const REPO_STOP = new Set(
  ("name named called naam file files folder code content this that it the a an and with me mein se ka ki ke wali wale wala repo " +
    "repository vercel netlify render github main master index ye yeh wo is isme usme same").split(" ")
);
const PLATFORMS = new Set(["vercel", "netlify", "render", "github"]);

function explicitRepo(c: string, exclude: string[]): string | null {
  const ex = new Set(exclude.map((x) => x.toLowerCase()));
  const ok = (w: string | undefined): w is string => !!w && !REPO_STOP.has(w.toLowerCase()) && !PLATFORMS.has(w.toLowerCase()) && !ex.has(w.toLowerCase());
  let m: RegExpExecArray | null;
  // "practice wali repo" / "practice repo"
  const reA = /(?<![\w.\-])([\w][\w.\-]*)\s+(?:wali\s+|wale\s+|ki\s+|ke\s+)?repo(?:sitory)?\b/gi;
  while ((m = reA.exec(c))) if (ok(m[1])) return m[1];
  // "repo practice" / "repo named practice"
  const reB = /\brepo(?:sitory)?\s+(?:named\s+|called\s+|name\s+)?([\w][\w.\-]*)/gi;
  while ((m = reB.exec(c))) if (ok(m[1])) return m[1];
  // "in practice" / "inside practice"
  const reC = /\b(?:in|inside|into)\s+(?:the\s+)?([\w][\w.\-]*)/gi;
  while ((m = reC.exec(c))) if (ok(m[1])) return m[1];
  return null;
}

const WRITE_VERB = /\b(?:add|create|make|write|put|upload|save|push|commit|update|edit|change|replace|paste|banao|bana|bnao|bna|likho|likh|daal|dal|dalo|daalo|rakho|rakh|badlo|badal)\b/i;
const NON_WRITE_VERB = /\b(?:delete|remove|hata|hatao|uda|udao|read|show|dikha|dikhao|padh|padho|list)\b/i;

function parseFileWrites(c: string, ctx: Ctx): PlanStep[] | null {
  if (NON_WRITE_VERB.test(c)) return null;
  const blocks = [...c.matchAll(BLOCK_RE_G)].map((m) => ({ n: Number(m[1]), idx: m.index as number }));
  const hasBlock = blocks.length > 0;
  if (!hasBlock && !WRITE_VERB.test(c)) return null;

  const toks = fileTokens(c);
  const repo = explicitRepo(c, toks.map((t) => t.path)) ?? ctx.repo;
  if (!repo) return null;

  const mk = (path: string, n: number | null): PlanStep => {
    const params: Record<string, any> = { repo, path, message: `Add ${path} via Easy DevOps` };
    if (n !== null) params.content = ph(n);
    return {
      cmd: "CREATE_FILE",
      params,
      summary: `\`${path}\` likho (\`${repo}\`)`,
      instruction: n === null ? c : undefined,
      origin: "rules",
    };
  };

  if (hasBlock) {
    const steps: PlanStep[] = [];
    let prevEnd = -1;
    for (let b = 0; b < blocks.length; b++) {
      const blk = blocks[b];
      // sabse paas wala file-naam jo is block se pehle (aur pichle block ke baad) aaya
      let tok = [...toks].reverse().find((t) => t.idx < blk.idx && t.idx > prevEnd);
      // "{{BLOCK}} ko index.html me daalo" — code pehle, file naam baad me (sirf pehle block ke liye)
      if (!tok && b === 0) tok = toks.find((t) => t.idx > blk.idx);
      let path = tok?.path ?? null;
      if (!path && blocks.length === 1) path = ctx.lastPath;
      if (!path) return null;
      steps.push(mk(path, blk.n));
      prevEnd = blk.idx;
    }
    const paths = steps.map((s) => s.params.path.toLowerCase());
    if (new Set(paths).size !== paths.length) return null;
    ctx.repo = repo;
    ctx.lastPath = steps[steps.length - 1].params.path;
    return steps;
  }

  // block nahi: sirf ek file, content AI banayega (instruction = clause)
  if (toks.length !== 1) return null;
  ctx.repo = repo;
  ctx.lastPath = toks[0].path;
  return [mk(toks[0].path, null)];
}

const DEPLOY_FILLER = new Set(
  ("it this that isko ise usko same project repo site website app ye yeh wo ko to on pe par at in kar karo do de dena vercel netlify render " +
    "also bhi and aur then phir please plz now abhi live online hosting").split(" ")
);

function parseContextDeploy(c: string, ctx: Ctx): PlanStep[] | null {
  const m = /^(?:(?:please|plz|bhai|isko|ise|usko|it|this|that)\s+)*(deploy|import|connect|publish|host|launch|go\s+live|live\s*(?:kar|karo|kar\s*do))\b\s*(.*)$/i.exec(c);
  if (!m) return null;
  const verb = m[1].toLowerCase();
  const rest = m[2].toLowerCase();
  const extra = rest.split(/[^a-z0-9_.\-]+/).filter(Boolean).filter((w) => !DEPLOY_FILLER.has(w));
  if (extra.length) return null; // koi explicit naam hai jo parser samjha nahi — rules me guess nahi
  if (!ctx.repo) return null;
  const repo = ctx.repo;
  if (/netlify/.test(rest)) {
    return [{ cmd: "NETLIFY_DEPLOY", params: { site_name: repo }, summary: `\`${repo}\` ko Netlify pe deploy karo`, origin: "rules" }];
  }
  if (/\brender\b/.test(rest)) return null;
  if (/^(?:import|connect)/.test(verb)) {
    return [{ cmd: "VERCEL_IMPORT_REPO", params: { repo }, summary: `\`${repo}\` ko Vercel se connect (import) karo`, origin: "rules" }];
  }
  return [{ cmd: "VERCEL_DEPLOY", params: { project_name: repo }, summary: `\`${repo}\` ko Vercel pe deploy karo`, origin: "rules" }];
}

// ── summary (checklist line) ──
const q = (v: any) => `\`${String(v ?? "?")}\``;
const SUMMARY: Record<string, (p: any) => string> = {
  CREATE_REPO: (p) => `Repo ${q(p.repo)} banao`,
  DELETE_REPO: (p) => `Repo ${q(p.repo)} delete karo`,
  CREATE_FILE: (p) => `${q(p.path)} likho (${q(p.repo)})`,
  EDIT_FILE: (p) => `${q(p.path)} edit karo (${q(p.repo)})`,
  DELETE_FILE: (p) => `${q(p.path)} delete karo (${q(p.repo)})`,
  CREATE_BRANCH: (p) => `Branch ${q(p.branch)} banao (${q(p.repo)})`,
  CREATE_PR: (p) => `PR kholo ${q(p.head)} → ${q(p.base ?? "default")} (${q(p.repo)})`,
  MERGE_PR: (p) => `PR #${p.number} merge karo (${q(p.repo)})`,
  INVITE_COLLABORATOR: (p) => `${q(p.username ?? (p.usernames || []).join(", "))} ko ${q(p.repo)} me invite karo`,
  CODE_GENERATE: (p) => `AI se code likhwao (${q(p.repo)})`,
  GENERATE_RENDER_YAML: (p) => `render.yaml banao (${q(p.repo)})`,
  VERCEL_IMPORT_REPO: (p) => `${q(p.repo)} ko Vercel se connect (import) karo`,
  VERCEL_DEPLOY: (p) => `${q(p.project_name)} ko Vercel pe deploy karo`,
  VERCEL_SET_ENV: (p) => `Vercel env ${q(p.key)} set karo (${q(p.project_name)})`,
  VERCEL_DELETE_PROJECT: (p) => `Vercel project ${q(p.project_name)} delete karo`,
  VERCEL_ROLLBACK: (p) => `${q(p.project_name)} rollback karo`,
  NETLIFY_DEPLOY: (p) => `${q(p.site_name)} ko Netlify pe deploy karo`,
  NETLIFY_SET_ENV: (p) => `Netlify env ${q(p.key)} set karo (${q(p.site_name)})`,
  RENDER_CREATE_SERVICE: (p) => `${q(p.repo)} ke liye Render service banao`,
  RENDER_DEPLOY: (p) => `Render service ${q(p.service_id)} deploy karo`,
  RENDER_SET_ENV: (p) => `Render env set karo (${q(p.service_id)})`,
  LIST_REPOS: () => `Repos ki list dikhao`,
  LIST_FILES: (p) => `${q(p.repo)} ki files dikhao`,
  READ_FILE: (p) => `${q(p.path)} padho (${q(p.repo)})`,
  GET_REPO_INFO: (p) => `${q(p.repo)} ki info`,
  VERCEL_LIST_PROJECTS: () => `Vercel projects ki list`,
  GITHUB_CHECK_STATUS: (p) => `${q(p.repo)} ka CI status`,
};

export function summarizeStep(cmd: string, params: Record<string, any>): string {
  const f = SUMMARY[cmd];
  if (f) return f(params);
  const first = params.repo ?? params.project_name ?? params.site_name ?? params.service_id ?? "";
  return `${cmd}${first ? " " + q(first) : ""}`;
}

function stepFromMatch(m: IntentMatch, clause: string): PlanStep {
  const params = { ...m.params };
  const step: PlanStep = { cmd: m.cmd, params, summary: "", origin: "rules" };
  if (AI_ASSISTED_COMMANDS.has(m.cmd)) step.instruction = clause; // content/code AI banayega
  if (m.cmd === "CODE_GENERATE") step.params.instruction = clause;
  step.summary = summarizeStep(m.cmd, params);
  return step;
}

const PRONOUNS = new Set(["it", "this", "that", "isko", "ise", "usko", "same", "project", "repo", "site", "ye", "yeh"]);
const ACTION_G = new RegExp(String.raw`\b${ACTION}\b`, "gi");

export function resolveClause(clause: string, ctx: Ctx): PlanStep[] | null {
  if (BLOCK_TEST.test(clause)) {
    // Ek hi clause me do alag kaam ("repo bna de x aur x me file me <code> daal de") — chup-chap ek kaam
    // chhodna khatarnak hai, isliye "and/aur" pe todke har tukda alag resolve karo.
    const verbs = (clause.replace(BLOCK_RE_G, " ").match(ACTION_G) || []).length;
    if (verbs >= 2) {
      const pieces = clause.split(/\s+(?:and|aur|&)\s+/i).map(cleanClause).filter(Boolean);
      if (pieces.length > 1) {
        const all: PlanStep[] = [];
        for (const p of pieces) {
          const r = resolveClause(p, ctx);
          if (!r) return null;
          all.push(...r);
        }
        return all;
      }
      return null;
    }
    return parseFileWrites(clause, ctx);
  }

  // "deploy it" jaise pronoun wale clause pehle (warna parser "it" ko project naam samajh leta)
  const ctxDeploy = parseContextDeploy(clause, ctx);
  if (ctxDeploy) return ctxDeploy;

  const m = parseIntentEx(clause);
  if (m) {
    if (!m.aiAssisted && m.leftoverWords >= PARTIAL_WORDS) return null;
    for (const key of ["project_name", "site_name"] as const) {
      const v = m.params[key];
      if (typeof v === "string" && PRONOUNS.has(v.toLowerCase())) {
        if (!ctx.repo) return null;
        m.params[key] = ctx.repo;
      }
    }
    const step = stepFromMatch(m, clause);
    const repo = m.params.repo;
    if (typeof repo === "string" && repo && !repo.includes("/")) ctx.repo = repo;
    if ((m.cmd === "CREATE_FILE" || m.cmd === "EDIT_FILE") && typeof m.params.path === "string") ctx.lastPath = m.params.path;
    if (m.cmd === "VERCEL_DEPLOY" || m.cmd === "VERCEL_IMPORT_REPO") {
      ctx.repo = (m.params.project_name ?? m.params.repo ?? ctx.repo) as string | null;
    }
    return [step];
  }

  return parseFileWrites(clause, ctx);
}

/** Naya repo + Vercel deploy: beech me import zaroori hai — user ko ye pata nahi hona chahiye. */
export function insertSmartSteps(steps: PlanStep[]): PlanStep[] {
  const out: PlanStep[] = [];
  const created = new Set<string>();
  const imported = new Set<string>();
  for (const s of steps) {
    if (s.cmd === "CREATE_REPO") created.add(String(s.params.repo).toLowerCase());
    if (s.cmd === "VERCEL_IMPORT_REPO") imported.add(String(s.params.repo).toLowerCase());
    if (s.cmd === "VERCEL_DEPLOY") {
      const name = String(s.params.project_name).toLowerCase();
      if (created.has(name) && !imported.has(name)) {
        out.push({
          cmd: "VERCEL_IMPORT_REPO",
          params: { repo: s.params.project_name },
          summary: `${q(s.params.project_name)} ko Vercel se connect (import) karo — nayi repo ke liye zaroori`,
          origin: "rules",
        });
        imported.add(name);
      }
    }
    out.push(s);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// 4. CLASSIFY — message ka rasta tay karo
// ════════════════════════════════════════════════════════════════
export type Classification =
  | { kind: "none" }
  | { kind: "single"; match: IntentMatch }
  | { kind: "chain"; steps: PlanStep[]; blocks: string[] }
  | {
      kind: "needs_ai";
      reason: "partial" | "unresolved";
      text: string;
      blocks: string[];
      clauses: string[];
      unresolved: string[];
      understood?: IntentMatch;
    };

export function classifyMessage(message: string): Classification {
  const { text, blocks } = extractBlocks(message);
  const clauses = splitClauses(text);

  // Seedha single command (sabse common case, 0 tokens) — purana behavior
  if (clauses.length <= 1 && blocks.length === 0) {
    const m = parseIntentEx(message);
    if (!m) return { kind: "none" };
    if (!m.aiAssisted && m.leftoverWords >= PARTIAL_WORDS) {
      return { kind: "needs_ai", reason: "partial", text, blocks, clauses, unresolved: [m.leftover], understood: m };
    }
    return { kind: "single", match: m };
  }

  const ctx: Ctx = { repo: null, lastPath: null };
  const steps: PlanStep[] = [];
  const unresolved: string[] = [];
  for (const clause of clauses) {
    const r = resolveClause(clause, ctx);
    if (!r) {
      unresolved.push(clause);
      continue;
    }
    for (const s of r) {
      // "file banao index.html" + "usme ye code daalo": pichle bina-content step me code jodo
      const prev = steps[steps.length - 1];
      if (
        prev &&
        prev.cmd === "CREATE_FILE" &&
        s.cmd === "CREATE_FILE" &&
        prev.params.content === undefined &&
        s.params.content !== undefined &&
        String(prev.params.path).toLowerCase() === String(s.params.path).toLowerCase() &&
        prev.params.repo === s.params.repo
      ) {
        prev.params.content = s.params.content;
        prev.instruction = undefined;
        continue;
      }
      steps.push(s);
    }
  }

  if (unresolved.length === 0 && steps.length > 0 && steps.length <= MAX_STEPS) {
    return { kind: "chain", steps: insertSmartSteps(steps), blocks };
  }
  return { kind: "needs_ai", reason: "unresolved", text, blocks, clauses, unresolved };
}

export const isDestructiveStep = (s: { cmd: string }) => DESTRUCTIVE.has(s.cmd);

// ════════════════════════════════════════════════════════════════
// 5. PLANNER support — AI ke plan ko validate/sanitize karo (AI par bharosa nahi)
// ════════════════════════════════════════════════════════════════
interface Spec {
  req: string[];
  opt?: string[];
}
export const PLAN_SPECS: Record<string, Spec> = {
  CREATE_REPO: { req: ["repo"] },
  DELETE_REPO: { req: ["repo"] },
  CREATE_FILE: { req: ["repo", "path"], opt: ["content", "message"] },
  EDIT_FILE: { req: ["repo", "path"], opt: ["content", "message"] },
  DELETE_FILE: { req: ["repo", "path"], opt: ["message"] },
  CREATE_BRANCH: { req: ["repo", "branch"], opt: ["base"] },
  CREATE_PR: { req: ["repo", "head"], opt: ["base", "title", "body"] },
  MERGE_PR: { req: ["repo", "number"], opt: ["method", "delete_branch"] },
  INVITE_COLLABORATOR: { req: ["repo", "username"], opt: ["permission"] },
  GENERATE_RENDER_YAML: { req: ["repo"] },
  CODE_GENERATE: { req: ["repo"] },
  VERCEL_IMPORT_REPO: { req: ["repo"], opt: ["project_name"] },
  VERCEL_DEPLOY: { req: ["project_name"] },
  VERCEL_SET_ENV: { req: ["project_name", "key", "value"] },
  NETLIFY_DEPLOY: { req: ["site_name"] },
  NETLIFY_SET_ENV: { req: ["site_name", "key", "value"] },
  RENDER_CREATE_SERVICE: { req: ["repo"] },
  RENDER_DEPLOY: { req: ["service_id"], opt: ["clear_cache"] },
  LIST_REPOS: { req: [] },
  LIST_FILES: { req: ["repo"], opt: ["path"] },
  READ_FILE: { req: ["repo", "path"] },
  GET_REPO_INFO: { req: ["repo"] },
  VERCEL_LIST_PROJECTS: { req: [] },
  GITHUB_CHECK_STATUS: { req: ["repo"], opt: ["ref"] },
  VERCEL_ROLLBACK: { req: ["project_name"], opt: ["deployment_id"] },
  VERCEL_DELETE_PROJECT: { req: ["project_name"] },
};

/** AI planner ke prompt me jaane wali compact command list (~250 tokens) */
export function plannerCommandList(): string {
  return Object.entries(PLAN_SPECS)
    .map(([cmd, sp]) => `${cmd} {${[...sp.req, ...(sp.opt ?? []).map((o) => o + "?")].join(",")}}`)
    .join("\n");
}

const REPO_NAME = /^[A-Za-z0-9_.\-]{1,100}$/;
const MAX_STR = 300;

export function validatePlanSteps(
  raw: unknown,
  blockCount: number
): { steps: PlanStep[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { steps: [], error: "empty plan" };
  if (raw.length > MAX_STEPS) return { steps: [], error: `max ${MAX_STEPS} steps allowed` };
  const steps: PlanStep[] = [];
  for (const item of raw) {
    const cmd = String((item as any)?.cmd ?? (item as any)?.command ?? "").trim().toUpperCase();
    const spec = PLAN_SPECS[cmd];
    if (!spec) return { steps: [], error: `unknown command: ${cmd || "?"}` };
    const inP = (item as any)?.params && typeof (item as any).params === "object" ? (item as any).params : {};
    const params: Record<string, any> = {};
    for (const key of [...spec.req, ...(spec.opt ?? [])]) {
      const v = inP[key];
      if (v === undefined || v === null || v === "") continue;
      if (key === "delete_branch" || key === "clear_cache") {
        params[key] = Boolean(v);
      } else if (key === "number") {
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) return { steps: [], error: `${cmd}: number galat` };
        params[key] = n;
      } else if (typeof v === "string" || typeof v === "number") {
        const sv = String(v);
        if (key === "content") {
          // sirf {{BLOCK_n}} placeholder allowed — AI ka likha content drop (server AI se alag se banwata hai)
          const bm = /^\s*\{\{BLOCK_(\d+)\}\}\s*$/.exec(sv);
          if (bm && Number(bm[1]) >= 1 && Number(bm[1]) <= blockCount) params.content = ph(Number(bm[1]));
          continue;
        }
        if (sv.length > MAX_STR) return { steps: [], error: `${cmd}.${key} bahut lamba` };
        params[key] = sv.trim();
      } else {
        return { steps: [], error: `${cmd}.${key} galat type` };
      }
    }
    for (const key of spec.req) {
      if (params[key] === undefined) {
        if (cmd === "CODE_GENERATE" && key === "instruction") continue;
        return { steps: [], error: `${cmd}: '${key}' missing` };
      }
    }
    for (const key of ["repo", "project_name", "site_name"]) {
      if (typeof params[key] === "string" && !REPO_NAME.test(params[key])) {
        return { steps: [], error: `${cmd}.${key} naam galat (owner/repo allowed nahi)` };
      }
    }
    const instruction =
      typeof (item as any)?.instruction === "string" ? String((item as any).instruction).slice(0, 600) : undefined;
    const step: PlanStep = { cmd, params, summary: "", origin: "planner" };
    if (cmd === "CODE_GENERATE") {
      if (!instruction) return { steps: [], error: "CODE_GENERATE: instruction missing" };
      step.params.instruction = instruction;
      step.instruction = instruction;
    } else if ((cmd === "CREATE_FILE" || cmd === "EDIT_FILE") && params.content === undefined) {
      step.instruction = instruction ?? `${cmd === "EDIT_FILE" ? "Update" : "Create"} ${params.path}`;
    }
    step.summary = summarizeStep(cmd, params);
    steps.push(step);
  }
  return { steps: insertSmartSteps(steps) };
}
