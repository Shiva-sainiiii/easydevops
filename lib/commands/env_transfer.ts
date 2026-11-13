/**
 * ENV VAR FILE IMPORT/EXPORT (env_transfer.py ka port).
 * IMPORT teeno platforms pe same (per-key write). EXPORT: Render full KEY=value,
 * Vercel/Netlify sirf "KEY=" scaffold (unki API values return nahi karti).
 */
import { vcApi, vercelFindProject } from "@/lib/providers/vercel";
import { nlApi, netlifyFindSite } from "@/lib/providers/netlify";
import { rdApi } from "@/lib/providers/render";
import { K, gd } from "@/lib/commands/pyutil";
import { pyStr } from "@/lib/pyjson";

// "KEY=value", "KEY = value", "export KEY=value"; quoted values ok
const ENV_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/;

export class EnvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvParseError";
  }
}

// String form: literal U+2028/2029 regex-literal me emit hone pe syntax error de sakte hain
const LINE_BREAKS = new RegExp("\\r\\n|[\\n\\r\\x0b\\x0c\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]");

/** Python str.splitlines() */
function splitLines(text: string): string[] {
  const parts = text.split(LINE_BREAKS);
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** .env text -> ordered {key: value}. Galat line pe line number ke saath EnvParseError. */
export function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = ENV_LINE_RE.exec(line);
    if (!m) {
      throw new EnvParseError(`Line ${i + 1} samajh nahi aayi: \`${rawLine.trim().slice(0, 60)}\``);
    }
    const key = m[1];
    let value = m[2].trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === "'" || value[0] === '"')) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  if (!Object.keys(result).length) {
    throw new EnvParseError("File me koi valid KEY=value line nahi mili.");
  }
  return result;
}

export const MAX_ENV_VARS_PER_IMPORT = 100;

export async function importEnvVars(
  platform: string,
  targetName: string,
  envDict: Record<string, string>,
  vcToken: string | null = null,
  nlToken: string | null = null,
  rdToken: string | null = null
): Promise<Record<string, any>> {
  const n = Object.keys(envDict).length;
  if (n > MAX_ENV_VARS_PER_IMPORT) {
    return {
      reply: `❌ ${n} vars ek file me — ${MAX_ENV_VARS_PER_IMPORT} se zyada ek baar me support nahi hai.`,
      action: "error",
    };
  }
  if (platform === "vercel") return importVercel(targetName, envDict, vcToken);
  if (platform === "netlify") return importNetlify(targetName, envDict, nlToken);
  if (platform === "render") return importRender(targetName, envDict, rdToken);
  return { reply: `❌ Platform \`${platform}\` pehchana nahi.`, action: "error" };
}

async function importVercel(projectName: string, envDict: Record<string, string>, vcToken: string | null) {
  if (!vcToken) {
    return { reply: "🔒 Pehle Vercel connect karo — user menu me 'Connect Vercel' dabao.", action: "vercel_auth_required" };
  }
  const proj = await vercelFindProject(projectName, vcToken);
  if (!proj) {
    return { reply: `❌ Vercel project \`${projectName}\` nahi mila.`, action: "error" };
  }
  const projId = gd(proj, "id", null);

  const okKeys: string[] = [];
  const failed: string[] = [];
  for (const [key, value] of Object.entries(envDict)) {
    const r = await vcApi("POST", `/v10/projects/${pyStr(projId)}/env`, vcToken, {
      json: { key, value, type: "encrypted", target: ["production", "preview", "development"] },
    });
    if (r.status_code === 200 || r.status_code === 201) okKeys.push(key);
    else if (r.status_code === 401 || r.status_code === 403) {
      return { reply: "❌ Vercel token invalid ya expire ho gaya. Dubara connect karo.", action: "vercel_auth_required" };
    } else failed.push(key);
  }
  return importSummary("Vercel", projectName, okKeys, failed, "vercel_env_set");
}

async function importNetlify(siteName: string, envDict: Record<string, string>, nlToken: string | null) {
  if (!nlToken) {
    return { reply: "🔒 Pehle Netlify connect karo — user menu me 'Connect Netlify' dabao.", action: "netlify_auth_required" };
  }
  const site = await netlifyFindSite(siteName, nlToken);
  if (!site) {
    return { reply: `❌ Netlify site \`${siteName}\` nahi mili.`, action: "error" };
  }
  const accountId = gd(site, "account_id", null);
  if (!accountId) {
    return { reply: "❌ Is site ka account_id nahi mila.", action: "error" };
  }

  const okKeys: string[] = [];
  const failed: string[] = [];
  for (const [key, value] of Object.entries(envDict)) {
    const payload = {
      key,
      scopes: ["builds", "functions", "runtime", "post_processing"],
      values: [{ value, context: "all" }],
    };
    const r = await nlApi("POST", `/accounts/${accountId}/env?site_id=${K(site, "id")}`, nlToken, { json: payload });
    if (r.status_code === 200 || r.status_code === 201) okKeys.push(key);
    else if (r.status_code === 401 || r.status_code === 403) {
      return { reply: "❌ Netlify token invalid ya expire ho gaya. Dubara connect karo.", action: "netlify_auth_required" };
    } else failed.push(key);
  }
  return importSummary("Netlify", siteName, okKeys, failed, "netlify_env_set");
}

async function importRender(serviceId: string, envDict: Record<string, string>, rdToken: string | null) {
  if (!rdToken) {
    return { reply: "🔒 Pehle Render connect karo — user menu me 'Connect Render' dabao.", action: "render_auth_required" };
  }

  // Render ka env-vars endpoint full PUT (replace-all) hai — pehle existing merge karo
  const existingR = await rdApi("GET", `/services/${serviceId}/env-vars?limit=100`, rdToken);
  const existing = new Map<string, any>();
  if (existingR.status_code === 200) {
    for (const item of existingR.json()) {
      existing.set(K(K(item, "envVar"), "key"), K(K(item, "envVar"), "value"));
    }
  } else if (existingR.status_code === 401 || existingR.status_code === 403) {
    return { reply: "❌ Render token invalid ya expire ho gaya. Dubara connect karo.", action: "render_auth_required" };
  }

  for (const [k, v] of Object.entries(envDict)) existing.set(k, v);
  const payload = Array.from(existing.entries()).map(([k, v]) => ({ key: k, value: v }));
  const r = await rdApi("PUT", `/services/${serviceId}/env-vars`, rdToken, { json: payload });
  if (r.status_code === 200 || r.status_code === 201) {
    return importSummary("Render", serviceId, Object.keys(envDict), [], "render_env_update");
  } else if (r.status_code === 401 || r.status_code === 403) {
    return { reply: "❌ Render token invalid ya expire ho gaya. Dubara connect karo.", action: "render_auth_required" };
  } else {
    return { reply: `❌ Env import Error: ${r.text.slice(0, 200)}`, action: "error" };
  }
}

function importSummary(platformLabel: string, targetName: string, okKeys: string[], failed: string[], action: string) {
  if (!okKeys.length && failed.length) {
    return {
      reply: `❌ Koi bhi env var import nahi hua \`${targetName}\` me. Fail hui: ${failed.join(", ")}`,
      action: "error",
    };
  }
  const keysLine = okKeys.map((k) => `\`${k}\``).join(", ");
  let reply = `✅ ${okKeys.length} env vars import ho gaye \`${targetName}\` (${platformLabel}) me!\n${keysLine}`;
  if (failed.length) reply += `\n\n⚠️ Fail hui: ${failed.join(", ")}`;
  reply += "\n\n⚠️ Naya deploy trigger karo changes apply karne ke liye.";
  return { reply, action, imported: okKeys, failed };
}

export type EnvExportResult = [string, string, string | null] | { error: string };

/** Returns [filename, fileText, warning|null] ya {error}. */
export async function exportEnvFile(
  platform: string,
  targetName: string,
  vcToken: string | null = null,
  nlToken: string | null = null,
  rdToken: string | null = null
): Promise<EnvExportResult> {
  if (platform === "render") return exportRender(targetName, rdToken);
  if (platform === "vercel") return exportVercel(targetName, vcToken);
  if (platform === "netlify") return exportNetlify(targetName, nlToken);
  return { error: `Platform \`${platform}\` pehchana nahi.` };
}

const toText = (lines: string[]) => lines.join("\n") + (lines.length ? "\n" : "");

async function exportRender(serviceId: string, rdToken: string | null): Promise<EnvExportResult> {
  if (!rdToken) return { error: "Render connected nahi hai." };
  const r = await rdApi("GET", `/services/${serviceId}/env-vars?limit=100`, rdToken);
  if (r.status_code === 401 || r.status_code === 403) return { error: "Render token invalid ya expire ho gaya." };
  if (r.status_code !== 200) return { error: `Env vars fetch nahi hue: ${r.text.slice(0, 200)}` };
  const items: any[] = r.json();
  const lines = items.map((item) => `${K(K(item, "envVar"), "key")}=${pyStr(K(K(item, "envVar"), "value"))}`);
  return [`${serviceId}.env`, toText(lines), null];
}

async function exportVercel(projectName: string, vcToken: string | null): Promise<EnvExportResult> {
  if (!vcToken) return { error: "Vercel connected nahi hai." };
  const proj = await vercelFindProject(projectName, vcToken);
  if (!proj) return { error: `Vercel project \`${projectName}\` nahi mila.` };
  const r = await vcApi("GET", `/v9/projects/${pyStr(gd(proj, "id", null))}/env`, vcToken);
  if (r.status_code === 401 || r.status_code === 403) return { error: "Vercel token invalid ya expire ho gaya." };
  if (r.status_code !== 200) return { error: `Env vars fetch nahi hue: ${r.text.slice(0, 200)}` };
  const envs: any[] = gd(r.json(), "envs", []);
  const warning =
    "Vercel apni env var VALUES kabhi API se return nahi karta (encrypted-at-rest) — " +
    "ye sirf KEYS ka scaffold hai, values manually bharni padengi. Full backup ke liye " +
    "`vercel env pull` CLI command use karo.";
  const lines = envs.map((e) => `${K(e, "key")}=`);
  return [`${projectName}.env`, toText(lines), warning];
}

async function exportNetlify(siteName: string, nlToken: string | null): Promise<EnvExportResult> {
  if (!nlToken) return { error: "Netlify connected nahi hai." };
  const site = await netlifyFindSite(siteName, nlToken);
  if (!site) return { error: `Netlify site \`${siteName}\` nahi mili.` };
  const accountId = gd(site, "account_id", null);
  if (!accountId) return { error: "Is site ka account_id nahi mila." };
  const r = await nlApi("GET", `/accounts/${accountId}/env?site_id=${K(site, "id")}`, nlToken);
  if (r.status_code === 401 || r.status_code === 403) return { error: "Netlify token invalid ya expire ho gaya." };
  if (r.status_code !== 200) return { error: `Env vars fetch nahi hue: ${r.text.slice(0, 200)}` };
  const envs: any[] = r.json();
  const warning =
    "Netlify apni env var VALUES API se return nahi karta (encrypted-at-rest) — " +
    "ye sirf KEYS ka scaffold hai, values manually bharni padengi.";
  const lines = envs.map((e) => `${K(e, "key")}=`);
  return [`${siteName}.env`, toText(lines), warning];
}
