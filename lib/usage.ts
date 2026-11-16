/**
 * USAGE TRACKING — har chat request aur har AI API attempt ka record.
 *
 *  - runUsageScope(): ek /chat request ka scope (AsyncLocalStorage). Request ke andar jitni baar AI call hui
 *    (aiChat -> recordAiAttempt) wo scope me jama hoti hai.
 *  - safeJsonify (lib/security.ts) response banate waqt scope se `usage` nikalta hai:
 *        { mode: "rules" | "hybrid" | "ai", ai_calls, provider, model, tokens, ms }
 *    aur frontend har reply ke saath badge dikhata hai ("⚡ Rules · 0 AI" / "🤖 AI · model").
 *  - Sab kuch `usage_log` table me (github_id se bandha, isliye logout ke baad bhi history rehti hai).
 *    Prompts / replies / keys kabhi store nahi hote — sirf counts, provider, model, status, tokens.
 *
 * Logging fail ho to app ko kabhi nahi rokta (har DB call try/catch).
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { query } from "@/lib/db";
import { summarizeUsage, type AiAttempt, type UsageInfo, type UsageMode, type UsageScope } from "@/lib/usage_core";

export { summarizeUsage };
export type { AiAttempt, UsageInfo, UsageMode };

const als = new AsyncLocalStorage<UsageScope>();

export function runUsageScope<T>(fn: () => Promise<T>): Promise<T> {
  return als.run({ userId: null, attempts: [], finalized: false }, fn);
}

export const currentUsageScope = (): UsageScope | undefined => als.getStore();

/** Chat route me user pehchaan hone ke baad bind karo (taaki response pe usage lag sake). */
export function bindUsageUser(userId: number | string): void {
  const s = als.getStore();
  if (s) s.userId = userId;
}

// ── github_id lookup (users.id -> users.github_id), chhota cache ──
const ghCache = new Map<string, string>();
async function githubIdOf(userId: number | string): Promise<string | null> {
  const k = String(userId);
  const hit = ghCache.get(k);
  if (hit) return hit;
  try {
    const rows = await query<{ github_id: string }>("SELECT github_id::text AS github_id FROM users WHERE id = $1", [userId]);
    const g = rows[0]?.github_id;
    if (!g) return null;
    if (ghCache.size > 500) ghCache.clear();
    ghCache.set(k, g);
    return g;
  } catch {
    return null;
  }
}

async function insertRow(
  userId: number | string,
  kind: "chat" | "ai_call",
  f: {
    mode?: string;
    action?: string;
    provider?: string;
    model?: string;
    status?: number;
    ms?: number;
    tokensIn?: number | null;
    tokensOut?: number | null;
  }
): Promise<void> {
  try {
    const gh = await githubIdOf(userId);
    if (!gh) return;
    await query(
      `INSERT INTO usage_log (github_id, kind, mode, action, provider, model, status, ms, tokens_in, tokens_out)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        gh,
        kind,
        f.mode ?? null,
        f.action ? String(f.action).slice(0, 60) : null,
        f.provider ?? null,
        f.model ? String(f.model).slice(0, 120) : null,
        f.status ?? null,
        f.ms != null ? Math.round(f.ms) : null,
        f.tokensIn ?? null,
        f.tokensOut ?? null,
      ]
    );
    if (Math.random() < 0.01) {
      // 400 din se purane rows saaf
      query("DELETE FROM usage_log WHERE ts < NOW() - INTERVAL '400 days'").catch(() => {});
    }
  } catch {
    /* usage logging kabhi request nahi todta */
  }
}

/** aiChat har provider HTTP attempt (429 retries / key fallback samet) yahan record karta hai. */
export async function recordAiAttempt(userId: number | string, a: AiAttempt): Promise<void> {
  const s = als.getStore();
  if (s) s.attempts.push(a);
  await insertRow(userId, "ai_call", a);
}

/**
 * Response banate waqt (safeJsonify): scope se UsageInfo nikalo, chat row log karo.
 * Scope nahi / user bind nahi / pehle hi finalize ho chuka -> null.
 */
export async function finalizeUsage(payload: Record<string, any>): Promise<UsageInfo | null> {
  const s = als.getStore();
  if (!s || s.userId == null || s.finalized) return null;
  s.finalized = true;
  const info = summarizeUsage(s.attempts, typeof payload.source === "string" ? payload.source : undefined);
  await insertRow(s.userId, "chat", { mode: info.mode, action: typeof payload.action === "string" ? payload.action : undefined });
  return info;
}
