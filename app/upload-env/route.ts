import { currentUser } from "@/lib/auth";
import { formFile, formStr, readForm } from "@/lib/api-utils";
import { getUserNetlifyToken, getUserRenderToken, getUserVercelToken } from "@/lib/db";
import { safeJsonify } from "@/lib/security";
import { EnvParseError, importEnvVars, parseEnvFile } from "@/lib/commands/env_transfer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ENV_UPLOAD_BYTES = 256 * 1024; // .env chhoti text file hoti hai

/** Bulk env import: .env file + platform (vercel/netlify/render) + target naam. */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return safeJsonify({ reply: "❌ Login chahiye.", action: "error" }, 401);

  const form = await readForm(req);
  const platform = formStr(form, "platform").toLowerCase();
  const target = formStr(form, "target");
  const f = formFile(form, "file");

  if (!["vercel", "netlify", "render"].includes(platform)) {
    return safeJsonify({ reply: "❌ Platform vercel/netlify/render me se ek honi chahiye.", action: "error" }, 400);
  }
  if (!target) {
    return safeJsonify({ reply: "❌ Project/site/service naam nahi diya.", action: "error" }, 400);
  }
  if (!f || f.name === "") {
    return safeJsonify({ reply: "❌ Koi .env file select nahi hui.", action: "error" }, 400);
  }

  const raw = Buffer.from(await f.arrayBuffer());
  if (raw.length > MAX_ENV_UPLOAD_BYTES) {
    return safeJsonify({ reply: "❌ File bahut badi hai — ye .env file jaisi nahi lagti.", action: "error" }, 413);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    return safeJsonify({ reply: "❌ File text nahi hai (UTF-8 decode fail hui).", action: "error" }, 400);
  }

  let envDict: Record<string, string>;
  try {
    envDict = parseEnvFile(text);
  } catch (e: any) {
    if (e instanceof EnvParseError) {
      return safeJsonify({ reply: `❌ .env parse nahi hui: ${e.message}`, action: "error" }, 400);
    }
    throw e;
  }

  const result = await importEnvVars(
    platform,
    target,
    envDict,
    platform === "vercel" ? getUserVercelToken(user) : null,
    platform === "netlify" ? getUserNetlifyToken(user) : null,
    platform === "render" ? getUserRenderToken(user) : null
  );
  const action = String(result.action ?? "");
  const status = action !== "error" && !action.includes("auth_required") ? 200 : 400;
  return safeJsonify(result, status);
}
