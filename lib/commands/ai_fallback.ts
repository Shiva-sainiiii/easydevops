/**
 * AI FALLBACK — sirf tab chalta hai jab regex intent parser kuch match nahi karta.
 * App ki apni OpenRouter key sirf language understanding / codegen ke liye use hoti hai —
 * use kisi ka GitHub token kabhi nahi milta; uska output bhi sirf executeCommand() ke
 * through, calling user ke token se hi GitHub tak pahunchta hai.
 */
import { config, OPENROUTER_MODEL } from "@/lib/config";
import { post } from "@/lib/http";
import { pyStr } from "@/lib/pyjson";
import { NO_ARG_COMMANDS } from "@/lib/commands/intent_parser";
import { executeCommand } from "@/lib/commands/executor";
import { AIError } from "@/lib/commands/errors";

export { AIError };

// ════════════════════════════════════════════════════════════════
const systemPrompt = (v: {
  login: string;
  vercel_clause: string;
  netlify_clause: string;
  render_clause: string;
  vercel_commands: string;
  netlify_commands: string;
  render_commands: string;
  vercel_note: string;
  netlify_note: string;
  render_note: string;
}) => `You are a Easy DevOps helping GitHub user: ${v.login}.
You control ONLY this user's own GitHub account${v.vercel_clause}${v.netlify_clause}${v.render_clause}. You act by outputting EXACTLY ONE command per response.

COMMANDS:
1. CREATE_REPO: <repo-name>
2. DELETE_REPO: <repo-name>
3. LIST_REPOS
4. CREATE_FILE: {"repo":"repo-name","path":"file.html","content":"full content","message":"commit message"}
5. READ_FILE: {"repo":"repo-name","path":"file.html"}
6. EDIT_FILE: {"repo":"repo-name","path":"file.html","content":"updated content","message":"what changed"}
7. DELETE_FILE: {"repo":"repo-name","path":"file.html","message":"reason"}
8. LIST_FILES: {"repo":"repo-name","path":""}
9. GET_REPO_INFO: {"repo":"repo-name"}
10. GENERATE_RENDER_YAML: {"repo":"repo-name"} — auto-detects the repo's stack and commits a render.yaml IaC blueprint
${v.vercel_commands}${v.netlify_commands}${v.render_commands}
RULES:
- Output ONLY the command, nothing else, UNLESS the request is conversational/explanatory.
- JSON must be valid. Escape quotes as \\" and newlines as \\n in content fields.
- NEVER invent URLs, IDs, or data you don't have — only the commands above give you real information.
- NEVER output anything resembling a real token/secret, even as an example.
${v.vercel_note}${v.netlify_note}${v.render_note}`;

const VERCEL_COMMANDS_BLOCK = `11. VERCEL_LIST_PROJECTS
12. VERCEL_IMPORT_REPO: {"repo":"repo-name","project_name":"optional-custom-name"}
13. VERCEL_DEPLOY: {"project_name":"project-name"}
14. VERCEL_DELETE_PROJECT: {"project_name":"project-name"}
15. VERCEL_GET_ENV: {"project_name":"project-name"}
16. VERCEL_SET_ENV: {"project_name":"project-name","key":"KEY","value":"value"}
17. VERCEL_ROLLBACK: {"project_name":"project-name","deployment_id":"optional-specific-id"} — omit deployment_id to rollback to the previous production deployment
18. VERCEL_LIST_DEPLOYMENTS: {"project_name":"project-name"}
`;

const NETLIFY_COMMANDS_BLOCK = `19. NETLIFY_LIST_SITES
20. NETLIFY_GET_SITE_INFO: {"site_name":"site-name"}
21. NETLIFY_DELETE_SITE: {"site_name":"site-name"}
22. NETLIFY_GET_ENV: {"site_name":"site-name"}
23. NETLIFY_SET_ENV: {"site_name":"site-name","key":"KEY","value":"value"}
`;

const RENDER_COMMANDS_BLOCK = `24. RENDER_LIST_SERVICES
25. RENDER_DELETE_SERVICE: {"service_id":"srv-xxx"}
26. RENDER_GET_ENV: {"service_id":"srv-xxx"}
27. RENDER_SET_ENV: {"service_id":"srv-xxx","env_vars":{"KEY":"value"}}
28. RENDER_DEPLOY: {"service_id":"srv-xxx","clear_cache":false}
`;

const CODEGEN_SYSTEM_PROMPT =
  "You generate file content for a developer tool. Output ONLY the raw file content — no markdown fences, no explanation. Write complete, working code. Infer language from the file path.";

const COMMANDS = [
  "CREATE_REPO:", "DELETE_REPO:", "LIST_REPOS", "CREATE_FILE:",
  "READ_FILE:", "EDIT_FILE:", "DELETE_FILE:", "LIST_FILES:", "GET_REPO_INFO:",
  "GENERATE_RENDER_YAML:",
  "VERCEL_LIST_PROJECTS", "VERCEL_IMPORT_REPO:", "VERCEL_DEPLOY:",
  "VERCEL_DELETE_PROJECT:", "VERCEL_GET_ENV:", "VERCEL_SET_ENV:",
  "VERCEL_ROLLBACK:", "VERCEL_LIST_DEPLOYMENTS:",
  "NETLIFY_LIST_SITES", "NETLIFY_GET_SITE_INFO:", "NETLIFY_DELETE_SITE:",
  "NETLIFY_GET_ENV:", "NETLIFY_SET_ENV:",
  "RENDER_LIST_SERVICES", "RENDER_DELETE_SERVICE:", "RENDER_GET_ENV:",
  "RENDER_SET_ENV:", "RENDER_DEPLOY:",
];

/** AI reply me se (command, value) nikalta hai. Python: sorted(COMMANDS, key=len, reverse=True) */
export function extractCommand(text: string): [string | null, string | null] {
  text = text.trim();
  const sorted = [...COMMANDS].sort((a, b) => b.length - a.length); // stable, longest first
  for (const cmd of sorted) {
    if (!text.includes(cmd)) continue;
    const bare = cmd.replace(/:+$/, "");
    if (NO_ARG_COMMANDS.has(bare)) return [bare, null];
    const idx = text.indexOf(cmd);
    let value = text.slice(idx + cmd.length).trim();
    if (value.startsWith("{")) {
      let braceCount = 0;
      let jsonEnd = 0;
      for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (ch === "{") braceCount += 1;
        else if (ch === "}") {
          braceCount -= 1;
          if (braceCount === 0) {
            jsonEnd = i + 1;
            break;
          }
        }
      }
      if (jsonEnd > 0) value = value.slice(0, jsonEnd);
    } else {
      value = value.split("\n")[0].trim();
    }
    return [bare, value];
  }
  return [null, null];
}

export async function callOpenrouterChat(
  userMessage: string,
  history: { role: string; content: string }[],
  githubLogin: string,
  vercelConnected = false,
  netlifyConnected = false,
  renderConnected = false
): Promise<string> {
  const vercel_clause = vercelConnected ? " and their connected Vercel account" : "";
  const vercel_commands = vercelConnected ? VERCEL_COMMANDS_BLOCK : "";
  const vercel_note = vercelConnected
    ? ""
    : "\nNote: this user has NOT connected Vercel yet — do not emit any VERCEL_* command; " +
      "if they ask for a Vercel action, tell them to connect Vercel first via the user menu.\n";
  const netlify_clause = netlifyConnected ? " and their connected Netlify account" : "";
  const netlify_commands = netlifyConnected ? NETLIFY_COMMANDS_BLOCK : "";
  const netlify_note = netlifyConnected
    ? ""
    : "\nNote: this user has NOT connected Netlify yet — do not emit any NETLIFY_* command; " +
      "if they ask for a Netlify action, tell them to connect Netlify first via the user menu.\n";
  const render_clause = renderConnected ? " and their connected Render account" : "";
  const render_commands = renderConnected ? RENDER_COMMANDS_BLOCK : "";
  const render_note = renderConnected
    ? ""
    : "\nNote: this user has NOT connected Render yet — do not emit any RENDER_* command; " +
      "if they ask for a Render action, tell them to connect Render first via the user menu.\n";

  const sysPrompt = systemPrompt({
    login: githubLogin,
    vercel_clause, vercel_commands, vercel_note,
    netlify_clause, netlify_commands, netlify_note,
    render_clause, render_commands, render_note,
  });

  const messages: { role: string; content: string }[] = [{ role: "system", content: sysPrompt }];
  for (const h of history.slice(-10)) {
    messages.push({ role: h["role"], content: h["content"] });
  }
  messages.push({ role: "user", content: userMessage });

  const resp = await post("https://openrouter.ai/api/v1/chat/completions", {
    headers: { Authorization: `Bearer ${pyStr(config.OPENROUTER_KEY ?? null)}`, "Content-Type": "application/json" },
    json: { model: OPENROUTER_MODEL, messages, temperature: 0.2 },
    timeout: 30,
  });
  const aiResp = resp.json();

  if (aiResp && typeof aiResp === "object" && "error" in aiResp) {
    throw new AIError(aiResp.error?.message ?? "Unknown AI error");
  }
  return String(aiResp.choices[0].message.content).trim();
}

export async function callOpenrouterCodegen(instruction: string, pathHint = ""): Promise<string> {
  const userPrompt = pathHint ? `File path: ${pathHint}\n\nInstruction: ${instruction}` : instruction;
  const resp = await post("https://openrouter.ai/api/v1/chat/completions", {
    headers: { Authorization: `Bearer ${pyStr(config.OPENROUTER_KEY ?? null)}`, "Content-Type": "application/json" },
    json: {
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: CODEGEN_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
    },
    timeout: 45,
  });
  const aiResp = resp.json();

  if (aiResp && typeof aiResp === "object" && "error" in aiResp) {
    throw new AIError(aiResp.error?.message ?? "Unknown AI error");
  }
  let content: string = String(aiResp.choices[0].message.content).trim();
  content = content.replace(/^```\w*\n/, "");
  content = content.replace(/\n```$/, "");
  return content;
}

export async function handleCreateOrEditFile(
  cmd: string,
  params: Record<string, any>,
  userMessage: string,
  owner: string,
  ghToken: string
): Promise<Record<string, any>> {
  const instruction = userMessage.trim();
  const aiContent = await callOpenrouterCodegen(instruction, "path" in params ? params.path : "");
  const fullParams = {
    repo: params["repo"],
    path: params["path"],
    content: aiContent,
    message: `${cmd === "EDIT_FILE" ? "Update" : "Add"} ${params["path"]} via Easy DevOps`,
  };
  const result = await executeCommand(cmd, fullParams, owner, ghToken);
  result["source"] = "hybrid";
  return result;
}
