/**
 * USAGE — pure types + summarize (koi import nahi, tests me seedha chalta hai).
 */
export type UsageMode = "rules" | "hybrid" | "ai";

export interface AiAttempt {
  provider: string;
  model: string;
  status: number; // HTTP status; 0 = network error / timeout
  ms: number;
  tokensIn?: number | null;
  tokensOut?: number | null;
}

export interface UsageScope {
  userId: number | string | null;
  attempts: AiAttempt[];
  finalized: boolean;
}

export interface UsageInfo {
  mode: UsageMode;
  ai_calls: number;
  provider?: string;
  model?: string;
  tokens?: number;
  ms?: number;
}

/** Pure: scope ki attempts + response source se mode/summary. */
export function summarizeUsage(attempts: AiAttempt[], source?: string): UsageInfo {
  if (attempts.length === 0) return { mode: "rules", ai_calls: 0 };
  const last = attempts[attempts.length - 1];
  const tokens = attempts.reduce((n, a) => n + (a.tokensIn ?? 0) + (a.tokensOut ?? 0), 0);
  const ms = attempts.reduce((n, a) => n + a.ms, 0);
  return {
    mode: source === "ai" ? "ai" : "hybrid",
    ai_calls: attempts.length,
    provider: last.provider,
    model: last.model,
    tokens: tokens || undefined,
    ms,
  };
}

