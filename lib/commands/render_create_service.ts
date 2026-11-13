/**
 * RENDER_CREATE_SERVICE — naya Render web service (render_create_service.py ka port).
 * Stack detection render_blueprint.detectStack se; workspace ownerId har baar GET /owners se.
 * Sab kuch Hinglish reply + "error" action ke saath fail-soft.
 */
import { ghApi } from "@/lib/providers/github";
import { rdApi } from "@/lib/providers/render";
import type { PyResponse } from "@/lib/http";
import { detectStack, pkgScripts, STACK_LABELS } from "@/lib/commands/render_blueprint";
import { K, gd } from "@/lib/commands/pyutil";

const VALID_PLANS = new Set(["free", "starter", "standard", "pro", "pro_plus", "pro_max", "pro_ultra"]);
const DEFAULT_PLAN = "free";
const VALID_REGIONS = new Set(["oregon", "ohio", "virginia", "frankfurt", "singapore"]);
const DEFAULT_REGION = "oregon";

const sortedList = (s: Set<string>) => Array.from(s).sort().join(", ");
const msgOf = (r: PyResponse, dflt: string): string => (r.content.length ? gd(r.json(), "message", dflt) : dflt);

/** Returns [runtime, buildCommand, startCommand] */
function stackEnvDetails(stack: string, pkgJson: any, hasAppPy: boolean): [string, string | null, string | null] {
  if (stack === "python") {
    return ["python", "pip install -r requirements.txt", hasAppPy ? "gunicorn app:app" : "python main.py"];
  }
  if (stack === "node") {
    const scripts = pkgScripts(pkgJson);
    const startCmd = "start" in scripts ? "npm start" : "node index.js";
    const buildCmd = "build" in scripts ? "npm install && npm run build" : "npm install";
    return ["node", buildCmd, startCmd];
  }
  if (stack === "go") return ["go", "go build -o app .", "./app"];
  if (stack === "ruby") return ["ruby", "bundle install", "bundle exec ruby app.rb"];
  // docker — Dockerfile se seedha build
  return ["docker", null, null];
}

/** Account ka pehla workspace. Returns [ownerId|null, response]. */
async function getOwnerId(rdToken: string): Promise<[string | null, PyResponse]> {
  const r = await rdApi("GET", "/owners?limit=20", rdToken);
  if (r.status_code !== 200) return [null, r];
  const owners = r.json();
  if (!owners || !owners.length) return [null, r];
  return [K(K(owners[0], "owner"), "id"), r];
}

export async function createRenderService(
  repo: string,
  owner: string,
  ghToken: string,
  rdToken: string | null,
  plan: string | null = null,
  branch: string | null = null,
  region: string | null = null
): Promise<Record<string, any>> {
  if (!rdToken) {
    return {
      reply: "🔒 Pehle Render connect karo — user menu me 'Connect Render' dabao.",
      action: "render_auth_required",
    };
  }

  plan = (plan || DEFAULT_PLAN).trim().toLowerCase();
  if (!VALID_PLANS.has(plan)) {
    return { reply: `❌ Plan \`${plan}\` valid nahi hai. Options: ${sortedList(VALID_PLANS)}.`, action: "error" };
  }

  region = (region || DEFAULT_REGION).trim().toLowerCase();
  if (!VALID_REGIONS.has(region)) {
    return { reply: `❌ Region \`${region}\` valid nahi hai. Options: ${sortedList(VALID_REGIONS)}.`, action: "error" };
  }

  const repoR = await ghApi("GET", `/repos/${owner}/${repo}`, ghToken);
  if (repoR.status_code !== 200) {
    return { reply: `❌ GitHub: ${msgOf(repoR, "Repo nahi mila")}`, action: "error" };
  }
  const repoData = repoR.json();
  const repoUrl = gd(repoData, "html_url", null);
  const defaultBranch = gd(repoData, "default_branch", "main");
  const useBranch = (branch || defaultBranch).trim();

  const rootR = await ghApi("GET", `/repos/${owner}/${repo}/contents/`, ghToken);
  if (rootR.status_code !== 200) {
    return { reply: `❌ GitHub: ${msgOf(rootR, "Repo root read nahi hui")}`, action: "error" };
  }
  const rootEntries: any[] = rootR.json();
  const rootNames: string[] = rootEntries.filter((e) => gd(e, "type", null) === "file").map((e) => K(e, "name"));

  const stack = detectStack(rootNames);
  if (!stack) {
    return {
      reply:
        "⚠️ Stack detect nahi hui — root me koi jaana-pehchana marker file " +
        "(requirements.txt, package.json, go.mod, Gemfile, Dockerfile) nahi mili. " +
        "Render service manually banana padega dashboard se.",
      action: "warning",
    };
  }

  let pkgJson: any = null;
  if (stack === "node") {
    const pkgR = await ghApi("GET", `/repos/${owner}/${repo}/contents/package.json`, ghToken);
    if (pkgR.status_code === 200) {
      try {
        pkgJson = JSON.parse(Buffer.from(K(pkgR.json(), "content"), "base64").toString("utf-8"));
      } catch {
        pkgJson = null;
      }
    }
  }
  const hasAppPy = rootNames.includes("app.py");

  const [runtime, buildCmd, startCmd] = stackEnvDetails(stack, pkgJson, hasAppPy);

  const [ownerId, ownersR] = await getOwnerId(rdToken);
  if (ownerId === null) {
    if (ownersR.status_code === 401 || ownersR.status_code === 403) {
      return { reply: "❌ Render token invalid ya expire ho gaya. Dubara connect karo.", action: "render_auth_required" };
    }
    return { reply: `❌ Render workspace fetch nahi hua: ${ownersR.text.slice(0, 200)}`, action: "error" };
  }

  const serviceDetails: Record<string, any> = { region, plan, runtime };
  if (buildCmd !== null || startCmd !== null) {
    const envSpecific: Record<string, any> = {};
    if (buildCmd !== null) envSpecific.buildCommand = buildCmd;
    if (startCmd !== null) envSpecific.startCommand = startCmd;
    serviceDetails.envSpecificDetails = envSpecific;
  }

  const payload = {
    type: "web_service",
    name: repo,
    ownerId,
    repo: repoUrl,
    branch: useBranch,
    autoDeploy: "yes",
    serviceDetails,
  };

  const r = await rdApi("POST", "/services", rdToken, { json: payload });
  if (r.status_code === 201) {
    const data = r.json();
    const svc = gd(data, "service", data);
    const sid = gd(svc, "id", "");
    const svcUrl = gd(gd(svc, "serviceDetails", {}), "url", "");
    const stackLabel = STACK_LABELS[stack];
    const cmdNote = buildCmd ? `\nBuild: \`${buildCmd}\`\nStart: \`${startCmd}\`` : "\nDockerfile se build hogi.";
    const urlNote = svcUrl ? `\n🔗 ${svcUrl}` : "";
    return {
      reply:
        `✅ Render web service ban gayi!\n**${repo}** (${stackLabel} detect hui, \`${plan}\` plan, \`${region}\`)\n` +
        `ID: \`${sid}\`${cmdNote}${urlNote}\n\n` +
        `⚠️ Pehli deploy automatically shuru ho jayegi — build/start command check kar lena agar apka setup standard se hatke hai.`,
      action: "render_create_service",
      service_id: sid,
      repo,
    };
  } else if (r.status_code === 401 || r.status_code === 403) {
    return { reply: "❌ Render token invalid ya expire ho gaya. Dubara connect karo.", action: "render_auth_required" };
  } else if (r.status_code === 402) {
    return {
      reply: `❌ Ye plan (\`${plan}\`) ke liye Render workspace me billing info chahiye. Free plan try karo ya Render dashboard me card add karo.`,
      action: "error",
    };
  } else if (r.status_code === 409) {
    return {
      reply: `❌ Render me \`${repo}\` naam ki service already exist karti hai. Alag naam try karo dashboard se, ya existing service ko hi deploy karo.`,
      action: "error",
    };
  } else {
    let errMsg = "Service create nahi hui";
    try {
      errMsg = gd(r.json(), "message", errMsg);
    } catch {
      /* body JSON nahi tha */
    }
    return { reply: `❌ Render Error: ${errMsg}`, action: "error" };
  }
}
