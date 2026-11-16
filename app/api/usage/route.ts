import { query } from "@/lib/db";
import { rateLimitUser, tooManyRequests } from "@/lib/ratelimit";
import { requireUser } from "@/lib/route-utils";
import { safeJsonify } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Browser ka timezone (Intl) — galat/unknown ho to UTC. */
async function validTimezone(tz: string | null): Promise<string> {
  if (!tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return "UTC";
  try {
    await query("SELECT now() AT TIME ZONE $1", [tz]);
    return tz;
  } catch {
    return "UTC";
  }
}

const n = (v: any) => Number(v ?? 0) || 0;

/**
 * GET /api/usage?tz=Asia/Kolkata
 * Dashboard data: aaj / is mahine ke requests (rules vs AI), per-minute (60 min), per-day (30 din),
 * per-month (6 mahine), provider+model wise AI calls (free-limit meters ke liye).
 * Sirf apna data (github_id se).
 */
export async function GET(req: Request) {
  const { user, err } = await requireUser();
  if (err) return err;
  const rl = await rateLimitUser(user.id, "usage", 30, 60);
  if (!rl.ok) return tooManyRequests(rl);

  const tz = await validTimezone(new URL(req.url).searchParams.get("tz"));
  const gh = user.github_id;

  const B = `WITH b AS (
      SELECT (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2) AS d0,
             (date_trunc('month', now() AT TIME ZONE $2) AT TIME ZONE $2) AS m0
    )`;

  const [tot, models, perMin, perDay, perMonth, peaks] = await Promise.all([
    query<any>(
      `${B}
       SELECT
         count(*) FILTER (WHERE kind='chat' AND ts >= b.d0) AS chats_today,
         count(*) FILTER (WHERE kind='chat' AND mode='rules' AND ts >= b.d0) AS rules_today,
         count(*) FILTER (WHERE kind='chat' AND mode='hybrid' AND ts >= b.d0) AS hybrid_today,
         count(*) FILTER (WHERE kind='chat' AND mode='ai' AND ts >= b.d0) AS ai_today,
         count(*) FILTER (WHERE kind='ai_call' AND ts >= b.d0) AS calls_today,
         count(*) FILTER (WHERE kind='chat') AS chats_month,
         count(*) FILTER (WHERE kind='chat' AND mode='rules') AS rules_month,
         count(*) FILTER (WHERE kind='chat' AND mode='hybrid') AS hybrid_month,
         count(*) FILTER (WHERE kind='chat' AND mode='ai') AS ai_month,
         count(*) FILTER (WHERE kind='ai_call') AS calls_month,
         count(*) FILTER (WHERE kind='chat' AND ts >= now() - interval '1 minute') AS chats_1m,
         count(*) FILTER (WHERE kind='ai_call' AND ts >= now() - interval '1 minute') AS calls_1m
       FROM usage_log CROSS JOIN b
       WHERE github_id = $1 AND ts >= b.m0`,
      [gh, tz]
    ),
    query<any>(
      `${B}
       SELECT provider, model,
         count(*) FILTER (WHERE ts >= now() - interval '1 minute') AS calls_1m,
         count(*) FILTER (WHERE ts >= b.d0) AS calls_today,
         count(*) FILTER (WHERE ts >= b.d0 AND status = 429) AS limited_today,
         count(*) AS calls_month,
         coalesce(sum(coalesce(tokens_in,0) + coalesce(tokens_out,0)), 0) AS tokens_month,
         max(ts) AS last_ts
       FROM usage_log CROSS JOIN b
       WHERE github_id = $1 AND kind = 'ai_call' AND ts >= b.m0
       GROUP BY provider, model
       ORDER BY calls_month DESC
       LIMIT 20`,
      [gh, tz]
    ),
    query<any>(
      `SELECT date_trunc('minute', ts) AS t,
              count(*) FILTER (WHERE kind='chat') AS chats,
              count(*) FILTER (WHERE kind='ai_call') AS calls
       FROM usage_log
       WHERE github_id = $1 AND ts >= now() - interval '60 minutes'
       GROUP BY 1 ORDER BY 1`,
      [gh]
    ),
    query<any>(
      `SELECT to_char(date_trunc('day', ts AT TIME ZONE $2), 'YYYY-MM-DD') AS d,
              count(*) FILTER (WHERE kind='chat' AND mode='rules') AS rules,
              count(*) FILTER (WHERE kind='chat' AND mode='hybrid') AS hybrid,
              count(*) FILTER (WHERE kind='chat' AND mode='ai') AS ai,
              count(*) FILTER (WHERE kind='ai_call') AS calls
       FROM usage_log
       WHERE github_id = $1 AND ts >= now() - interval '31 days'
       GROUP BY 1 ORDER BY 1`,
      [gh, tz]
    ),
    query<any>(
      `SELECT to_char(date_trunc('month', ts AT TIME ZONE $2), 'YYYY-MM') AS m,
              count(*) FILTER (WHERE kind='chat' AND mode='rules') AS rules,
              count(*) FILTER (WHERE kind='chat' AND mode='hybrid') AS hybrid,
              count(*) FILTER (WHERE kind='chat' AND mode='ai') AS ai,
              count(*) FILTER (WHERE kind='ai_call') AS calls
       FROM usage_log
       WHERE github_id = $1 AND ts >= now() - interval '190 days'
       GROUP BY 1 ORDER BY 1`,
      [gh, tz]
    ),
    query<any>(
      `SELECT
         coalesce(max(chats), 0) AS peak_chats_per_min,
         coalesce(max(calls), 0) AS peak_calls_per_min
       FROM (
         SELECT count(*) FILTER (WHERE kind='chat') AS chats, count(*) FILTER (WHERE kind='ai_call') AS calls
         FROM usage_log
         WHERE github_id = $1 AND ts >= now() - interval '24 hours'
         GROUP BY date_trunc('minute', ts)
       ) x`,
      [gh]
    ),
  ]);

  const t = tot[0] ?? {};
  return safeJsonify({
    tz,
    totals: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, n(v)])),
    models: models.map((m: any) => ({
      provider: m.provider,
      model: m.model,
      calls_1m: n(m.calls_1m),
      calls_today: n(m.calls_today),
      limited_today: n(m.limited_today),
      calls_month: n(m.calls_month),
      tokens_month: n(m.tokens_month),
      last_ts: m.last_ts,
    })),
    per_minute: perMin.map((r: any) => ({ t: r.t, chats: n(r.chats), calls: n(r.calls) })),
    per_day: perDay.map((r: any) => ({ d: r.d, rules: n(r.rules), hybrid: n(r.hybrid), ai: n(r.ai), calls: n(r.calls) })),
    per_month: perMonth.map((r: any) => ({ m: r.m, rules: n(r.rules), hybrid: n(r.hybrid), ai: n(r.ai), calls: n(r.calls) })),
    peaks: {
      chats_per_min: n(peaks[0]?.peak_chats_per_min),
      calls_per_min: n(peaks[0]?.peak_calls_per_min),
    },
  });
}
