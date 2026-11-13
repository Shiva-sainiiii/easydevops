/**
 * GENERATE_RENDER_YAML — repo ke root files dekh kar render.yaml blueprint banata aur commit karta hai
 * (render_blueprint.py ka port). Detection simple marker-file based hai.
 */
import { ghApi, getFileSha } from "@/lib/providers/github";
import { safeRepoPath, UnsafePathError } from "@/lib/security";
import { pyJsonDumps } from "@/lib/pyjson";
import type { PyResponse } from "@/lib/http";
import { K, gd } from "@/lib/commands/pyutil";

/** Pehla match jeetta hai — order matter karta hai. */
export function detectStack(rootNames: string[]): string | null {
  const has = (n: string) => rootNames.includes(n);
  if (has("requirements.txt") || has("Pipfile") || has("pyproject.toml")) return "python";
  if (has("go.mod")) return "go";
  if (has("Gemfile")) return "ruby";
  if (has("package.json")) return "node";
  if (rootNames.some((n) => n.toLowerCase() === "dockerfile")) return "docker";
  return null;
}

/** pkg_json["scripts"] (dict ho tabhi) */
export function pkgScripts(pkgJson: any): Record<string, any> {
  if (pkgJson && typeof pkgJson === "object" && !Array.isArray(pkgJson)) {
    const s = gd(pkgJson, "scripts", {});
    return s && typeof s === "object" ? s : {};
  }
  return {};
}

type Svc = Record<string, any>;

function pythonService(repo: string, hasFlaskAppPy: boolean): Svc {
  const start = hasFlaskAppPy ? "gunicorn app:app" : "python main.py";
  return {
    type: "web",
    name: repo,
    runtime: "python",
    buildCommand: "pip install -r requirements.txt",
    startCommand: start,
    envVars: [{ key: "PYTHON_VERSION", value: "3.11.0" }],
  };
}

function nodeService(repo: string, pkgJson: any): Svc {
  const scripts = pkgScripts(pkgJson);
  const startCmd = "start" in scripts ? "npm start" : "node index.js";
  let buildCmd = "npm install";
  if ("build" in scripts) buildCmd = "npm install && npm run build";
  return { type: "web", name: repo, runtime: "node", buildCommand: buildCmd, startCommand: startCmd };
}

const goService = (repo: string): Svc => ({
  type: "web", name: repo, runtime: "go", buildCommand: "go build -o app .", startCommand: "./app",
});
const rubyService = (repo: string): Svc => ({
  type: "web", name: repo, runtime: "ruby", buildCommand: "bundle install", startCommand: "bundle exec ruby app.rb",
});
const dockerService = (repo: string): Svc => ({
  type: "web", name: repo, runtime: "docker", dockerfilePath: "./Dockerfile",
});

/** Hand-rolled minimal YAML emitter (blueprint hamesha services-list-of-dicts). */
function toYaml(blueprint: { services: Svc[] }): string {
  const scalar = (v: any): string => {
    if (typeof v === "boolean") return v ? "true" : "false";
    const s = String(v);
    if (s === "" || /[:#{}\[\]&*!|>'"%@`,]/.test(s) || s !== s.trim()) return pyJsonDumps(s, false);
    return s;
  };

  const lines: string[] = ["services:"];
  for (const svc of blueprint.services) {
    let first = true;
    for (const [key, val] of Object.entries(svc)) {
      const prefix = first ? "  - " : "    ";
      first = false;
      if (key === "envVars" && Array.isArray(val)) {
        if (!val.length) continue;
        lines.push(`${prefix}envVars:`);
        for (const ev of val) {
          lines.push(`      - key: ${scalar(ev["key"])}`);
          if ("value" in ev) lines.push(`        value: ${scalar(ev["value"])}`);
          else if ("sync" in ev) lines.push(`        sync: ${scalar(ev["sync"])}`);
        }
        continue;
      }
      lines.push(`${prefix}${key}: ${scalar(val)}`);
    }
  }
  return lines.join("\n") + "\n";
}

export const STACK_LABELS: Record<string, string> = {
  python: "Python", node: "Node.js", go: "Go", ruby: "Ruby", docker: "Dockerfile",
};

const msgOf = (r: PyResponse, dflt: string): string => (r.content.length ? gd(r.json(), "message", dflt) : dflt);

export async function generateRenderYaml(repo: string, owner: string, ghToken: string): Promise<Record<string, any>> {
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
        "render.yaml manually banana padega.",
      action: "warning",
    };
  }

  let service: Svc;
  if (stack === "python") {
    service = pythonService(repo, rootNames.includes("app.py"));
  } else if (stack === "node") {
    let pkgJson: any = null;
    const pkgR = await ghApi("GET", `/repos/${owner}/${repo}/contents/package.json`, ghToken);
    if (pkgR.status_code === 200) {
      try {
        pkgJson = JSON.parse(Buffer.from(K(pkgR.json(), "content"), "base64").toString("utf-8"));
      } catch {
        pkgJson = null;
      }
    }
    service = nodeService(repo, pkgJson);
  } else if (stack === "go") {
    service = goService(repo);
  } else if (stack === "ruby") {
    service = rubyService(repo);
  } else {
    service = dockerService(repo);
  }

  const yamlContent = toYaml({ services: [service] });

  let path: string;
  try {
    path = safeRepoPath("render.yaml");
  } catch (e: any) {
    if (e instanceof UnsafePathError) return { reply: `❌ Path allowed nahi hai: ${e.message}`, action: "error" };
    throw e;
  }

  const existingSha = await getFileSha(repo, path, owner, ghToken);
  const contentB64 = Buffer.from(yamlContent, "utf-8").toString("base64");
  const message = existingSha ? "Regenerate render.yaml via Easy DevOps" : "Add render.yaml (auto-generated) via Easy DevOps";
  const payload: Record<string, any> = { message, content: contentB64 };
  if (existingSha) payload.sha = existingSha;

  const r = await ghApi("PUT", `/repos/${owner}/${repo}/contents/${path}`, ghToken, { json: payload });
  if (r.status_code !== 200 && r.status_code !== 201) {
    return { reply: `❌ GitHub Error: ${msgOf(r, "render.yaml commit nahi hua")}`, action: "error" };
  }

  const url = K(K(r.json(), "content"), "html_url");
  const verb = existingSha ? "Update" : "Bana";
  const stackLabel = STACK_LABELS[stack];
  return {
    reply:
      `✅ render.yaml ${verb} di! (${stackLabel} stack detect hui)\n` +
      `**${path}**\n🔗 ${url}\n\n` +
      `⚠️ Ek baar file check kar lena — build/start command apne repo ke hisaab se ` +
      `adjust karne padh sakte hain deploy karne se pehle.`,
    action: existingSha ? "update_file" : "create_file",
    url,
    repo,
  };
}
