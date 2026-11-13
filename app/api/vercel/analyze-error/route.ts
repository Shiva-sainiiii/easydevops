import { currentUser } from "@/lib/auth";
import { config, OPENROUTER_MODEL } from "@/lib/config";
import { post } from "@/lib/http";
import { pyStr } from "@/lib/pyjson";
import { readJsonBody } from "@/lib/route-utils";
import { redact, safeJsonify } from "@/lib/security";
import { AIError } from "@/lib/commands/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ERROR_ANALYSIS_SYSTEM_PROMPT = `You are a build-log triage assistant. You are given the tail of a failed
Vercel build log. Reply in Hinglish, in at most 4 short lines total:
1. One line naming the likely root cause (be specific — package name, file, command).
2. One line with the concrete fix (a command to run, a line to change, a config to add).
Do not repeat the raw log back. Do not add disclaimers or a greeting. If the log genuinely
doesn't contain enough signal to guess a cause, say so in one line instead of inventing one.`;

/** Failed deploy ke log tail se chhota AI diagnosis (frontend state===ERROR pe ek hi baar). */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return safeJsonify({ reply: "Session expired.", action: "auth_required" }, 401);

  const data = await readJsonBody(req);
  const lines: any[] = data.lines || [];
  const errorMessage = String(data.error_message || "").trim();
  if (!lines.length && !errorMessage) {
    return safeJsonify({ suggestion: null, error: "no log content" }, 400);
  }

  const logTail = lines.slice(-60).map((l) => pyStr(l)).join("\n");
  const userPrompt = `Error message: ${errorMessage}\n\nBuild log (tail):\n${logTail}`.slice(0, 6000);

  try {
    const resp = await post("https://openrouter.ai/api/v1/chat/completions", {
      headers: { Authorization: `Bearer ${pyStr(config.OPENROUTER_KEY ?? null)}`, "Content-Type": "application/json" },
      json: {
        model: OPENROUTER_MODEL,
        messages: [
          { role: "system", content: ERROR_ANALYSIS_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
      },
      timeout: 25,
    });
    const aiResp = resp.json();
    if (aiResp && typeof aiResp === "object" && "error" in aiResp) {
      throw new AIError(aiResp.error?.message ?? "Unknown AI error");
    }
    let suggestion: string = String(aiResp.choices[0].message.content).trim();
    suggestion = redact(suggestion);
    return safeJsonify({ suggestion });
  } catch {
    return safeJsonify({ suggestion: null, error: "AI analysis abhi available nahi hai." }, 200);
  }
}
