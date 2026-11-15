/**
 * RATE LIMIT — fixed-window counter.
 *
 * Production: Upstash Redis (REST, koi package nahi chahiye) — env: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN.
 * Env na ho (ya Upstash down ho) to in-memory fallback (har serverless instance ka apna counter — best-effort).
 *
 * Edge + Node dono me chalta hai (middleware.ts bhi yahi use karta hai): koi node-only import nahi.
 */

export interface RateResult {
  ok: boolean;
  limit: number;
  remaining: number;
  retryAfter: number; // seconds
}

const mem = new Map<string, { count: number; resetAt: number }>();

function memHit(key: string, limit: number, windowSec: number, now: number): RateResult {
  if (mem.size > 5000) {
    for (const [k, v] of mem) if (v.resetAt <= now) mem.delete(k);
    if (mem.size > 5000) mem.clear();
  }
  let e = mem.get(key);
  if (!e || e.resetAt <= now) {
    e = { count: 0, resetAt: now + windowSec * 1000 };
    mem.set(key, e);
  }
  e.count++;
  return {
    ok: e.count <= limit,
    limit,
    remaining: Math.max(0, limit - e.count),
    retryAfter: Math.max(1, Math.ceil((e.resetAt - now) / 1000)),
  };
}

async function upstashHit(key: string, limit: number, windowSec: number, now: number): Promise<RateResult | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const win = Math.floor(now / 1000 / windowSec);
  const k = `rl:${key}:${win}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 1500);
  try {
    const r = await fetch(`${url.replace(/\/$/, "")}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([["INCR", k], ["EXPIRE", k, String(windowSec + 5)]]),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { result?: number }[];
    const count = Number(data?.[0]?.result);
    if (!Number.isFinite(count)) return null;
    const retryAfter = Math.max(1, (win + 1) * windowSec - Math.floor(now / 1000));
    return { ok: count <= limit, limit, remaining: Math.max(0, limit - count), retryAfter };
  } catch {
    return null; // Upstash down — fallback
  } finally {
    clearTimeout(t);
  }
}

/** `key` jaise "chat:42" ya "ip:1.2.3.4:post". windowSec ke andar `limit` se zyada hit pe ok=false. */
export async function rateLimit(key: string, limit: number, windowSec: number, now = Date.now()): Promise<RateResult> {
  return (await upstashHit(key, limit, windowSec, now)) ?? memHit(key, limit, windowSec, now);
}

export const rateLimitUser = (userId: number | string, bucket: string, limit: number, windowSec: number) =>
  rateLimit(`u:${bucket}:${userId}`, limit, windowSec);

/** 429 response (frontend `reply` dikhata hai) */
export function tooManyRequests(r: RateResult): Response {
  return new Response(
    JSON.stringify({
      reply: `⏳ Bahut zyada requests. ${r.retryAfter} second baad dobara try karo.`,
      action: "error",
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(r.retryAfter),
        "Cache-Control": "no-store",
      },
    }
  );
}

/** Sirf tests ke liye */
export function _resetRateLimitMemory(): void {
  mem.clear();
}
