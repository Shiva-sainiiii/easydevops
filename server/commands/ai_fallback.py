"""
AI FALLBACK — only reached when the regex intent parser finds nothing.
Uses the app's own OpenRouter key (app-level, shared infra) purely for
language understanding / codegen — it never gets anyone's GitHub token,
and its own output still only reaches GitHub through execute_command()
with the calling user's token.
"""
import re
import requests

from server.config import OPENROUTER_KEY
from server.commands.intent_parser import NO_ARG_COMMANDS
from server.commands.executor import execute_command


# ════════════════════════════════════════════════════════════════
OPENROUTER_MODEL = "nvidia/nemotron-3-super-120b-a12b:free"

SYSTEM_PROMPT_TEMPLATE = """You are a DevOps Agent helping GitHub user: {login}.
You control ONLY this user's own GitHub account{vercel_clause}{netlify_clause}{render_clause}. You act by outputting EXACTLY ONE command per response.

COMMANDS:
1. CREATE_REPO: <repo-name>
2. DELETE_REPO: <repo-name>
3. LIST_REPOS
4. CREATE_FILE: {{"repo":"repo-name","path":"file.html","content":"full content","message":"commit message"}}
5. READ_FILE: {{"repo":"repo-name","path":"file.html"}}
6. EDIT_FILE: {{"repo":"repo-name","path":"file.html","content":"updated content","message":"what changed"}}
7. DELETE_FILE: {{"repo":"repo-name","path":"file.html","message":"reason"}}
8. LIST_FILES: {{"repo":"repo-name","path":""}}
9. GET_REPO_INFO: {{"repo":"repo-name"}}
10. GENERATE_RENDER_YAML: {{"repo":"repo-name"}} — auto-detects the repo's stack and commits a render.yaml IaC blueprint
{vercel_commands}{netlify_commands}{render_commands}
RULES:
- Output ONLY the command, nothing else, UNLESS the request is conversational/explanatory.
- JSON must be valid. Escape quotes as \\" and newlines as \\n in content fields.
- NEVER invent URLs, IDs, or data you don't have — only the commands above give you real information.
- NEVER output anything resembling a real token/secret, even as an example.
{vercel_note}{netlify_note}{render_note}"""

VERCEL_COMMANDS_BLOCK = """11. VERCEL_LIST_PROJECTS
12. VERCEL_IMPORT_REPO: {"repo":"repo-name","project_name":"optional-custom-name"}
13. VERCEL_DEPLOY: {"project_name":"project-name"}
14. VERCEL_DELETE_PROJECT: {"project_name":"project-name"}
15. VERCEL_GET_ENV: {"project_name":"project-name"}
16. VERCEL_SET_ENV: {"project_name":"project-name","key":"KEY","value":"value"}
17. VERCEL_ROLLBACK: {"project_name":"project-name","deployment_id":"optional-specific-id"} — omit deployment_id to rollback to the previous production deployment
18. VERCEL_LIST_DEPLOYMENTS: {"project_name":"project-name"}
"""

NETLIFY_COMMANDS_BLOCK = """19. NETLIFY_LIST_SITES
20. NETLIFY_GET_SITE_INFO: {"site_name":"site-name"}
21. NETLIFY_DELETE_SITE: {"site_name":"site-name"}
22. NETLIFY_GET_ENV: {"site_name":"site-name"}
23. NETLIFY_SET_ENV: {"site_name":"site-name","key":"KEY","value":"value"}
"""

RENDER_COMMANDS_BLOCK = """24. RENDER_LIST_SERVICES
25. RENDER_DELETE_SERVICE: {"service_id":"srv-xxx"}
26. RENDER_GET_ENV: {"service_id":"srv-xxx"}
27. RENDER_SET_ENV: {"service_id":"srv-xxx","env_vars":{"KEY":"value"}}
28. RENDER_DEPLOY: {"service_id":"srv-xxx","clear_cache":false}
"""

CODEGEN_SYSTEM_PROMPT = """You generate file content for a developer tool. Output ONLY the raw file content — no markdown fences, no explanation. Write complete, working code. Infer language from the file path."""

COMMANDS = [
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
]


def extract_command(text):
    text = text.strip()
    for cmd in sorted(COMMANDS, key=len, reverse=True):
        if cmd not in text:
            continue
        bare = cmd.rstrip(":")
        if bare in NO_ARG_COMMANDS:
            return (bare, None)
        parts = text.split(cmd, 1)
        if len(parts) < 2:
            continue
        value = parts[1].strip()
        if value.startswith("{"):
            brace_count = 0
            json_end = 0
            for i, ch in enumerate(value):
                if ch == "{":
                    brace_count += 1
                elif ch == "}":
                    brace_count -= 1
                    if brace_count == 0:
                        json_end = i + 1
                        break
            if json_end > 0:
                value = value[:json_end]
        else:
            value = value.split("\n")[0].strip()
        return (bare, value)
    return (None, None)


def call_openrouter_chat(user_message, history, github_login, vercel_connected=False, netlify_connected=False, render_connected=False):
    vercel_clause = " and their connected Vercel account" if vercel_connected else ""
    vercel_commands = VERCEL_COMMANDS_BLOCK if vercel_connected else ""
    vercel_note = ("" if vercel_connected else
                   "\nNote: this user has NOT connected Vercel yet — do not emit any VERCEL_* command; "
                   "if they ask for a Vercel action, tell them to connect Vercel first via the user menu.\n")
    netlify_clause = " and their connected Netlify account" if netlify_connected else ""
    netlify_commands = NETLIFY_COMMANDS_BLOCK if netlify_connected else ""
    netlify_note = ("" if netlify_connected else
                     "\nNote: this user has NOT connected Netlify yet — do not emit any NETLIFY_* command; "
                     "if they ask for a Netlify action, tell them to connect Netlify first via the user menu.\n")
    render_clause = " and their connected Render account" if render_connected else ""
    render_commands = RENDER_COMMANDS_BLOCK if render_connected else ""
    render_note = ("" if render_connected else
                    "\nNote: this user has NOT connected Render yet — do not emit any RENDER_* command; "
                    "if they ask for a Render action, tell them to connect Render first via the user menu.\n")
    system_prompt = SYSTEM_PROMPT_TEMPLATE.format(
        login=github_login, vercel_clause=vercel_clause,
        vercel_commands=vercel_commands, vercel_note=vercel_note,
        netlify_clause=netlify_clause, netlify_commands=netlify_commands, netlify_note=netlify_note,
        render_clause=render_clause, render_commands=render_commands, render_note=render_note,
    )
    messages = [{"role": "system", "content": system_prompt}]
    for h in history[-10:]:
        messages.append({"role": h["role"], "content": h["content"]})
    messages.append({"role": "user", "content": user_message})

    ai_resp = requests.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={"Authorization": f"Bearer {OPENROUTER_KEY}", "Content-Type": "application/json"},
        json={"model": OPENROUTER_MODEL, "messages": messages, "temperature": 0.2},
        timeout=30
    ).json()

    if "error" in ai_resp:
        raise RuntimeError(ai_resp["error"].get("message", "Unknown AI error"))
    return ai_resp["choices"][0]["message"]["content"].strip()


def call_openrouter_codegen(instruction, path_hint=""):
    user_prompt = f"File path: {path_hint}\n\nInstruction: {instruction}" if path_hint else instruction
    ai_resp = requests.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={"Authorization": f"Bearer {OPENROUTER_KEY}", "Content-Type": "application/json"},
        json={
            "model": OPENROUTER_MODEL,
            "messages": [
                {"role": "system", "content": CODEGEN_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0.3,
        },
        timeout=45
    ).json()

    if "error" in ai_resp:
        raise RuntimeError(ai_resp["error"].get("message", "Unknown AI error"))
    content = ai_resp["choices"][0]["message"]["content"].strip()
    content = re.sub(r"^```[\w]*\n", "", content)
    content = re.sub(r"\n```$", "", content)
    return content


def handle_create_or_edit_file(cmd, params, user_message, owner, gh_token):
    instruction = user_message.strip()
    ai_content = call_openrouter_codegen(instruction, path_hint=params.get("path", ""))
    full_params = {
        "repo": params["repo"],
        "path": params["path"],
        "content": ai_content,
        "message": f"{'Update' if cmd == 'EDIT_FILE' else 'Add'} {params['path']} via DevOps Agent",
    }
    result = execute_command(cmd, full_params, owner, gh_token)
    result["source"] = "hybrid"
    return result

