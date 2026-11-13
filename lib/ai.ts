/**
 * AI GATEWAY — har user apni AI key (Google AI Studio / OpenRouter) lagata hai.
 * App ki koi shared key use nahi hoti: chat ka AI fallback, file generate, code generate
 * aur deploy-error analysis, sab calling user ki apni key + apne chune model se chalte hain.
 *
 * Dono providers OpenAI-compatible /chat/completions endpoint dete hain, isliye ek hi call shape.
 * Ek provider ki multiple keys ho sakti hain: 429 (limit) ya invalid key pe agli key try hoti hai,
 * aur sab keys khatam hon to doosre saved provider pe fallback.
 */
import { get, post, RequestException, Timeout } from "@/lib/http";
import { getAiKeys, getAiSettings } from "@/lib/db";
import { AIError, NoAIKeyError } from "@/lib/commands/errors";

export type AiProviderId = "google" | "openrouter";

export interface AiProvider {
  id: AiProviderId;
  label: string;
  base: string;
  key_url: string;
  key_hint: string;
}

export const AI_PROVIDERS: Record<AiProviderId, AiProvider> = {
  google: {
    id: "google",
    label: "Google AI Studio",
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    key_url: "https://aistudio.google.com/apikey",
    key_hint: "AIza...",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    base: "https://openrouter.ai/api/v1",
    key_url: "https://openrouter.ai/keys",
    key_hint: "sk-or-v1-...",
  },
};

export function isProvider(p: unknown): p is AiProviderId {
  return typeof p === "string" && Object.prototype.hasOwnProperty.call(AI_PROVIDERS, p);
}

export function validModelId(m: unknown): m is string {
  return typeof m === "string" && m.length > 0 && m.length <= 120 && /^[\w.\-:/]+$/.test(m);
}

function errMessage(j: any): string | null {
  // Google kabhi error ko array me lapet ke bhejta hai
  const e = Array.isArray(j) ? j[0]?.error : j?.error;
  if (!e) return null;
  return typeof e === "string" ? e : e.message ? String(e.message) : null;
}

/** true = valid, false = rejected, null = check nahi ho paya (network). */
export async function validateKey(provider: AiProviderId, key: string): Promise<boolean | null> {
  const url = provider === "openrouter" ? `${AI_PROVIDERS.openrouter.base}/auth/key` : `${AI_PROVIDERS.google.base}/models`;
  try {
    const r = await get(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, timeout: 12 });
    if (r.status_code === 200 || r.status_code === 429) return true;
    if (r.status_code === 400 || r.status_code === 401 || r.status_code === 403) return false;
    return null;
  } catch (e) {
    if (e instanceof RequestException) return null;
    throw e;
  }
}

const GOOGLE_SKIP = /embed|imagen|veo|tts|aqa|image|live|audio|robotics|computer-use|learnlm/i;

/** Provider ke models. OpenRouter: sirf free; Google: us key se dikhne wale Gemini/Gemma chat models. */
export async function listModels(provider: AiProviderId, key?: string): Promise<string[]> {
  if (provider === "openrouter") {
    const r = await get(`${AI_PROVIDERS.openrouter.base}/models`, { timeout: 15 });
    if (r.status_code !== 200) throw new AIError("OpenRouter se models list nahi mili.");
    const data: any[] = r.json()?.data ?? [];
    return data
      .map((m) => String(m?.id ?? ""))
      .filter((id) => id.endsWith(":free"))
      .sort();
  }
  if (!key) throw new AIError("Google models dekhne ke liye pehle ek key add karo.");
  const r = await get(`${AI_PROVIDERS.google.base}/models`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    timeout: 15,
  });
  if (r.status_code !== 200) throw new AIError(errMessage(safeJson(r.text)) ?? "Google se models list nahi mili.");
  const data: any[] = safeJson(r.text)?.data ?? [];
  return data
    .map((m) => String(m?.id ?? "").replace(/^models\//, ""))
    .filter((id) => /gemini|gemma/i.test(id) && !GOOGLE_SKIP.test(id))
    .sort();
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface ChatMessage {
  role: string;
  content: string;
}

/**
 * User ki apni key se chat completion. Text return karta hai.
 * Errors: NoAIKeyError (kuch set nahi), AIError (limit / invalid / model galat), Timeout (re-throw).
 */
export async function aiChat(
  userId: number | string,
  messages: ChatMessage[],
  opts: { temperature?: number; timeout?: number } = {}
): Promise<string> {
  const { temperature = 0.2, timeout = 30 } = opts;
  const settings = await getAiSettings(userId);

  const order: AiProviderId[] = [];
  if (isProvider(settings.active_provider)) order.push(settings.active_provider);
  for (const p of Object.keys(AI_PROVIDERS) as AiProviderId[]) if (!order.includes(p)) order.push(p);

  let tried = false;
  let lastReason = "";

  for (const prov of order) {
    const model = settings.models[prov];
    if (!model) continue;
    const keys = await getAiKeys(userId, prov);
    if (!keys.length) continue;
    tried = true;

    const start = Math.floor(Math.random() * keys.length); // load keys me failein
    for (let i = 0; i < keys.length; i++) {
      const key = keys[(start + i) % keys.length];
      let resp;
      try {
        resp = await post(`${AI_PROVIDERS[prov].base}/chat/completions`, {
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          json: { model, messages, temperature },
          timeout,
        });
      } catch (e) {
        if (e instanceof Timeout) throw e;
        lastReason = `${AI_PROVIDERS[prov].label}: connection error`;
        continue;
      }

      const j = safeJson(resp.text);
      if (resp.status_code === 429) {
        lastReason = `${AI_PROVIDERS[prov].label}: limit khatam (429)`;
        continue;
      }
      if (resp.status_code === 401 || resp.status_code === 403) {
        lastReason = `${AI_PROVIDERS[prov].label}: key invalid/expired`;
        continue;
      }
      if (resp.status_code !== 200) {
        const msg = errMessage(j) ?? `HTTP ${resp.status_code}`;
        if (/api key|quota|rate limit/i.test(msg)) {
          lastReason = `${AI_PROVIDERS[prov].label}: ${msg}`;
          continue;
        }
        throw new AIError(`${AI_PROVIDERS[prov].label} (${model}): ${msg}`);
      }
      const content = j?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new AIError(`${AI_PROVIDERS[prov].label} (${model}) ne khaali jawab diya. Model badal ke try karo.`);
      }
      return content.trim();
    }
  }

  if (!tried) throw new NoAIKeyError();
  throw new AIError(
    `Saari AI keys abhi kaam nahi kar rahi (${lastReason}). Thodi der baad try karo, ya AI Gateway me nayi key / dusra model lagao.`
  );
}
