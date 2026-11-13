import { isProvider, listModels } from "@/lib/ai";
import { AIError } from "@/lib/commands/errors";
import { getAiKeys } from "@/lib/db";
import { readJsonBody, requireUser } from "@/lib/route-utils";
import { safeJsonify } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Provider ke available models (Google ke liye user ki saved key se, OpenRouter ke liye free models)
export async function POST(req: Request) {
  const { user, err } = await requireUser();
  if (err) return err;

  const body = await readJsonBody(req);
  const provider = body.provider;
  if (!isProvider(provider)) return safeJsonify({ reply: "❌ Provider galat hai.", action: "error" }, 400);

  try {
    const keys = await getAiKeys(user.id, provider);
    const models = await listModels(provider, keys[0]);
    return safeJsonify({ models });
  } catch (e: any) {
    const msg = e instanceof AIError ? e.message : "Models list load nahi hui.";
    return safeJsonify({ reply: `❌ ${msg}`, action: "error", models: [] }, 502);
  }
}
