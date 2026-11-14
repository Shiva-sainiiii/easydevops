/** GitHub API wrapper, har GitHub-touching command/route use karta hai. */
import { request, type PyResponse, type RequestOptions } from "@/lib/http";

export function ghApi(
  method: string,
  endpoint: string,
  ghToken: string,
  opts: RequestOptions = {}
): Promise<PyResponse> {
  const url = `https://api.github.com${endpoint}`;
  const headers = {
    Authorization: `Bearer ${ghToken}`,
    Accept: "application/vnd.github+json",
    ...(opts.headers || {}),
  };
  return request(method, url, { ...opts, headers, timeout: 20 });
}

export async function getFileSha(repo: string, path: string, owner: string, ghToken: string): Promise<string | null> {
  const r = await ghApi("GET", `/repos/${owner}/${repo}/contents/${path}`, ghToken);
  if (r.status_code === 200) {
    return r.json().sha ?? null;
  }
  return null;
}

const LINK_NEXT_RE = /<([^>]+)>;\s*rel="next"/;

/**
 * User ke saare repos laata hai, single page pe bharosa karne ki jagah
 * `Link: rel="next"` header follow karke. max_total tak cap hai.
 *
 * Returns [repos, r] — r last response hai (caller status_code check karta hai).
 */
export async function ghListAllRepos(
  ghToken: string,
  perPage = 100,
  maxTotal = 300,
  affiliation = "owner" // "owner" = purana behaviour; "collaborator" = mere saath share kiye gaye repos
): Promise<[any[], PyResponse | null]> {
  let endpoint: string | null = `/user/repos?per_page=${perPage}&sort=updated&affiliation=${affiliation}`;
  const allRepos: any[] = [];
  let r: PyResponse | null = null;
  while (endpoint) {
    r = await ghApi("GET", endpoint, ghToken);
    if (r.status_code !== 200) break;
    const page = r.json();
    allRepos.push(...page);
    if (allRepos.length >= maxTotal || page.length < perPage) break;
    const linkHeader = r.headers.get("Link", "") ?? "";
    const match = LINK_NEXT_RE.exec(linkHeader);
    if (!match) break;
    // Link header full URL deta hai; ghApi ko sirf path+query chahiye
    const nextUrl = match[1];
    const idx = nextUrl.indexOf("api.github.com");
    endpoint = idx === -1 ? nextUrl : nextUrl.slice(idx + "api.github.com".length);
  }
  return [allRepos.slice(0, maxTotal), r];
}

/**
 * Commit/branch ref ke GitHub Actions check-runs laata hai.
 * Returns [checkRuns, r] — ghListAllRepos jaisi shape.
 */
export async function ghGetCheckRuns(
  repo: string,
  ref: string,
  owner: string,
  ghToken: string
): Promise<[any[], PyResponse]> {
  const r = await ghApi("GET", `/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100`, ghToken);
  if (r.status_code === 200) {
    return [r.json().check_runs ?? [], r];
  }
  return [[], r];
}

export interface CheckSummary {
  state: "none" | "pending" | "failure" | "success";
  total: number;
  passed: number;
  failed: number;
  pending: number;
  checks: { name: any; state: string; conclusion: any; url: any }[];
}

/**
 * Raw check_runs array ko chhote summary mein reduce karta hai (overall state +
 * pass/fail/pending counts + per-check list).
 *
 * Overall priority: koi run abhi queued/in_progress hai to pending jeetta hai,
 * failure tabhi jab kuch pending na ho.
 */
export function summarizeCheckRuns(checkRuns: any[]): CheckSummary {
  if (!checkRuns || checkRuns.length === 0) {
    return { state: "none", total: 0, passed: 0, failed: 0, pending: 0, checks: [] };
  }

  let passed = 0;
  let failed = 0;
  let pending = 0;
  const checks: CheckSummary["checks"] = [];
  for (const c of checkRuns) {
    const status = c.status; // queued | in_progress | completed
    const conclusion = c.conclusion;
    let runState: string;
    if (status !== "completed") {
      pending += 1;
      runState = "pending";
    } else if (conclusion === "success") {
      passed += 1;
      runState = "success";
    } else if (conclusion === "skipped" || conclusion === "neutral") {
      runState = "skipped";
    } else {
      failed += 1;
      runState = "failure";
    }
    checks.push({ name: c.name, state: runState, conclusion, url: c.html_url });
  }

  const overall = pending ? "pending" : failed ? "failure" : "success";
  return { state: overall, total: checkRuns.length, passed, failed, pending, checks };
}

// ════════════════════════════════════════════════════════════════
// COLLABORATION helpers — `owner/repo` addressing + permission check
// ════════════════════════════════════════════════════════════════

export interface RepoRef {
  owner: string;
  repo: string;
}

const REF_NAME_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * "owner/repo" ko todta hai. Sirf `owner/repo` form ke liye (jisme "/" ho) call karo —
 * bina "/" wale purane `repo` naam ka behaviour (owner = self) caller me hi rehta hai.
 * Galat format ya "." / ".." jaise path-traversal naam pe null.
 */
export function parseRepoRef(raw: string, selfLogin: string): RepoRef | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const parts = s.split("/");
  if (parts.length === 1) return REF_NAME_RE.test(parts[0]) ? { owner: selfLogin, repo: parts[0] } : null;
  if (parts.length !== 2) return null;
  const [o, r] = parts;
  if (!REF_NAME_RE.test(o) || !REF_NAME_RE.test(r)) return null;
  if (o === "." || o === ".." || r === "." || r === "..") return null;
  return { owner: o, repo: r };
}

/** GitHub logins case-insensitive hote hain. */
export function sameLogin(a: string, b: string): boolean {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/** GitHub error response se `message` (body JSON na ho to text ka chhota hissa). */
export function ghMsg(r: PyResponse, def = ""): string {
  try {
    const m = r.json()?.message;
    if (typeof m === "string" && m) return m;
  } catch {
    // body JSON nahi tha
  }
  return r.text ? r.text.slice(0, 200) : def;
}

export interface RepoAccess {
  fullName: string;
  admin: boolean;
  push: boolean;
  pull: boolean;
  role: "admin" | "maintain" | "push" | "triage" | "pull" | "none";
  defaultBranch: string | null;
  ownerType: string | null; // "User" | "Organization"
  isPrivate: boolean;
}

/** Non-200 GitHub response ko Hinglish error me badalta hai. */
export function ghAccessError(r: PyResponse, fullName: string): string {
  const msg = ghMsg(r);
  if (r.status_code === 401) return "🔒 GitHub token invalid ya expire ho gaya. Logout karke dubara GitHub se connect karo.";
  if (/rate limit/i.test(msg)) return "⏳ GitHub rate limit lag gaya. Thodi der baad dobara try karo.";
  if (r.status_code === 404) {
    return (
      `❌ Repo \`${fullName}\` nahi mila — ya to naam galat hai, ya tumhare paas uska access nahi hai ` +
      `(private repo me pehle invite accept karna padta hai).`
    );
  }
  if (r.status_code === 403) return `🔒 GitHub ne \`${fullName}\` ka access mana kar diya (403)${msg ? `: ${msg}` : "."}`;
  return `❌ GitHub Error (${r.status_code}): ${msg || "unknown"}`;
}

/**
 * Repo ke upar logged-in user ki asli permission GitHub se poochta hai —
 * client pe bharosa nahi, GitHub hi final judge hai.
 * Returns [access, null] ya [null, hinglishError].
 */
export async function ghRepoAccess(
  owner: string,
  repo: string,
  ghToken: string
): Promise<[RepoAccess | null, string | null]> {
  const r = await ghApi("GET", `/repos/${owner}/${repo}`, ghToken);
  if (r.status_code !== 200) return [null, ghAccessError(r, `${owner}/${repo}`)];
  const d = r.json();
  const perms = d?.permissions ?? {};
  const admin = !!perms.admin;
  const maintain = !!perms.maintain;
  const push = !!perms.push;
  const triage = !!perms.triage;
  const pull = !!perms.pull;
  const role = admin ? "admin" : maintain ? "maintain" : push ? "push" : triage ? "triage" : pull ? "pull" : "none";
  return [
    {
      fullName: d?.full_name ?? `${owner}/${repo}`,
      admin,
      push: admin || maintain || push,
      pull: admin || maintain || push || triage || pull,
      role,
      defaultBranch: d?.default_branch ?? null,
      ownerType: d?.owner?.type ?? null,
      isPrivate: !!d?.private,
    },
    null,
  ];
}
