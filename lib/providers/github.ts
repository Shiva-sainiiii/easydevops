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
  maxTotal = 300
): Promise<[any[], PyResponse | null]> {
  let endpoint: string | null = `/user/repos?per_page=${perPage}&sort=updated&affiliation=owner`;
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
