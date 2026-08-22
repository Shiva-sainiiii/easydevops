"""
Misc JSON API routes consumed by the frontend for autofill/live-data:
repo names, repo folders, repo files (all power the command-form
dropdowns), plus the Vercel live-build-log polling endpoint and the
AI error-analysis endpoint used by the deploy terminal drawer.
"""
import requests
import base64
import json
from flask import Blueprint, request

from server.config import OPENROUTER_KEY
from server.auth import current_user
from server.db import decrypt_token, get_user_vercel_token
from server.security import safe_jsonify, redact, safe_repo_path, UnsafePathError
from server.providers.github import gh_api, get_file_sha
from server.providers.vercel import vc_api, VERCEL_TERMINAL_STATES
from server.commands.ai_fallback import OPENROUTER_MODEL
from server.commands.confirmation import confirm_token, build_confirmation
from server.commands.bulk_actions import (
    bulk_delete_files, bulk_delete_repos, bulk_set_repo_visibility, bulk_delete_vercel_projects,
)

api_bp = Blueprint("api_routes", __name__)


@api_bp.route("/api/repos", methods=["GET"])
def api_list_repos():
    user = current_user()
    if not user:
        return safe_jsonify({"repos": []})
    gh_token = decrypt_token(user["github_token_encrypted"])
    r = gh_api("GET", "/user/repos?per_page=100&sort=updated&affiliation=owner", gh_token)
    if r.status_code != 200:
        return safe_jsonify({"repos": []})
    names = [rp["name"] for rp in r.json()]
    return safe_jsonify({"repos": names})


@api_bp.route("/api/vercel-projects", methods=["GET"])
def api_list_vercel_projects():
    # Mirrors /api/repos above — powers the {project_name} datalist in the
    # command-form bubble (VERCEL_DEPLOY, VERCEL_DELETE_PROJECT,
    # VERCEL_GET_ENV, VERCEL_SET_ENV) the same way repo names autofill for
    # GitHub commands. Silently returns an empty list (not an error) when
    # the user hasn't connected Vercel, matching the GitHub route's
    # not-logged-in behavior — the datalist just stays empty and the field
    # falls back to plain typing, no broken-looking error state.
    user = current_user()
    if not user:
        return safe_jsonify({"projects": []})
    vc_token = get_user_vercel_token(user)
    if not vc_token:
        return safe_jsonify({"projects": []})
    r = vc_api("GET", "/v9/projects", vc_token)
    if r.status_code != 200:
        return safe_jsonify({"projects": []})
    names = [p["name"] for p in r.json().get("projects", [])]
    return safe_jsonify({"projects": names})


@api_bp.route("/api/repo-folders", methods=["GET"])
def api_repo_folders():
    user = current_user()
    if not user:
        return safe_jsonify({"folders": []})
    gh_token = decrypt_token(user["github_token_encrypted"])
    owner = user["github_login"]
    repo = (request.args.get("repo") or "").strip()
    if not repo:
        return safe_jsonify({"folders": []})

    repo_r = gh_api("GET", f"/repos/{owner}/{repo}", gh_token)
    if repo_r.status_code != 200:
        return safe_jsonify({"folders": []})
    default_branch = repo_r.json().get("default_branch", "main")

    tree_r = gh_api("GET", f"/repos/{owner}/{repo}/git/trees/{default_branch}?recursive=1", gh_token)
    if tree_r.status_code != 200:
        return safe_jsonify({"folders": []})

    tree = tree_r.json().get("tree", [])
    folders = sorted({item["path"] for item in tree if item.get("type") == "tree"})
    return safe_jsonify({"folders": folders})


@api_bp.route("/api/repo-files", methods=["GET"])
def api_repo_files():
    # Same recursive-tree approach as /api/repo-folders — used to autofill
    # the {path} field for READ_FILE / EDIT_FILE / DELETE_FILE in the chat
    # UI's command form, so the user picks a real path instead of typing it.
    user = current_user()
    if not user:
        return safe_jsonify({"files": []})
    gh_token = decrypt_token(user["github_token_encrypted"])
    owner = user["github_login"]
    repo = (request.args.get("repo") or "").strip()
    if not repo:
        return safe_jsonify({"files": []})

    repo_r = gh_api("GET", f"/repos/{owner}/{repo}", gh_token)
    if repo_r.status_code != 200:
        return safe_jsonify({"files": []})
    default_branch = repo_r.json().get("default_branch", "main")

    tree_r = gh_api("GET", f"/repos/{owner}/{repo}/git/trees/{default_branch}?recursive=1", gh_token)
    if tree_r.status_code != 200:
        return safe_jsonify({"files": []})

    tree = tree_r.json().get("tree", [])
    files = sorted({item["path"] for item in tree if item.get("type") == "blob"})[:500]
    return safe_jsonify({"files": files})


# ════════════════════════════════════════════════════════════════
#  INLINE CODE EDITOR — backs the editor overlay in the frontend.
#
#  GET  /api/file-source  — fetches decoded text content for the editor
#       to open. Kept separate from the existing /download route
#       (file_routes.py) because that one streams raw bytes with a
#       Content-Disposition download header; this one returns JSON text
#       for the editor to bind to a <textarea>/CodeMirror doc.
#
#  POST /api/file-source  — commits editor content directly via a single
#       GitHub contents PUT, same call shape execute_command's EDIT_FILE
#       branch uses. Deliberately NOT routed through EDIT_FILE's normal
#       /chat path, since that path always sends the instruction through
#       OpenRouter for AI content-gen (see handle_create_or_edit_file) —
#       a manual editor save already HAS the exact final content the user
#       wants and shouldn't be rewritten by an LLM in between. Still goes
#       through the same safe_repo_path() guard and sha-based update as
#       every other file-write surface.
# ════════════════════════════════════════════════════════════════
MAX_EDITOR_FILE_BYTES = 2 * 1024 * 1024  # 2MB — generous for a text editor, keeps huge binaries out


@api_bp.route("/api/file-source", methods=["GET"])
def api_file_source():
    user = current_user()
    if not user:
        return safe_jsonify({"reply": "❌ Login chahiye.", "action": "error"}), 401
    gh_token = decrypt_token(user["github_token_encrypted"])
    owner = user["github_login"]

    repo = (request.args.get("repo") or "").strip()
    path = (request.args.get("path") or "").strip().lstrip("/")
    if not repo or not path:
        return safe_jsonify({"reply": "❌ repo aur path chahiye.", "action": "error"}), 400

    r = gh_api("GET", f"/repos/{owner}/{repo}/contents/{path}", gh_token)
    if r.status_code != 200:
        msg = r.json().get("message", "File nahi mili") if r.content else "File nahi mili"
        return safe_jsonify({"reply": f"❌ GitHub: {msg}", "action": "error"}), r.status_code

    data = r.json()
    if data.get("type") != "file":
        return safe_jsonify({"reply": "❌ Ye path ek file nahi hai.", "action": "error"}), 400
    if data.get("size", 0) > MAX_EDITOR_FILE_BYTES:
        return safe_jsonify({"reply": "❌ File bahut badi hai editor ke liye (2MB+). Download karke local me edit karo.", "action": "error"}), 413

    raw = base64.b64decode(data["content"])
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return safe_jsonify({"reply": "❌ Ye binary file lag rahi hai — text editor me nahi khul sakti.", "action": "error"}), 400

    return safe_jsonify({"repo": repo, "path": path, "content": text, "sha": data.get("sha")})


@api_bp.route("/api/file-source", methods=["POST"])
def api_file_source_save():
    user = current_user()
    if not user:
        return safe_jsonify({"reply": "❌ Login chahiye.", "action": "error"}), 401
    gh_token = decrypt_token(user["github_token_encrypted"])
    owner = user["github_login"]

    body = request.json or {}
    repo = (body.get("repo") or "").strip()
    raw_path = (body.get("path") or "").strip()
    content = body.get("content")
    expected_sha = (body.get("sha") or "").strip()
    message = (body.get("message") or "").strip()

    if not repo or not raw_path or content is None:
        return safe_jsonify({"reply": "❌ repo, path aur content chahiye.", "action": "error"}), 400

    try:
        path = safe_repo_path(raw_path)
    except UnsafePathError as e:
        return safe_jsonify({"reply": f"❌ Ye path allowed nahi hai: {e}", "action": "error"}), 400

    if len(content.encode("utf-8")) > MAX_EDITOR_FILE_BYTES:
        return safe_jsonify({"reply": "❌ Content bahut bada hai (2MB+).", "action": "error"}), 413

    current_sha = get_file_sha(repo, path, owner, gh_token)
    if not current_sha:
        return safe_jsonify({"reply": f"❌ File `{path}` exist nahi karti repo `{repo}` me.", "action": "error"}), 404

    # If the caller's sha doesn't match what's on GitHub right now, someone
    # else (or another tab) changed the file since the editor opened it —
    # refuse to blindly overwrite; the frontend surfaces this as a conflict
    # and offers to reload the latest content before saving again.
    if expected_sha and expected_sha != current_sha:
        return safe_jsonify({
            "reply": "⚠️ Ye file editor khulne ke baad kahi aur se update hui hai. Latest version reload karke dubara edit karo.",
            "action": "conflict",
        }), 409

    if not message:
        message = f"Edit {path} via inline editor"

    payload = {"message": message, "content": base64.b64encode(content.encode("utf-8")).decode(), "sha": current_sha}
    r = gh_api("PUT", f"/repos/{owner}/{repo}/contents/{path}", gh_token, json=payload)
    if r.status_code in (200, 201):
        url = r.json()["content"]["html_url"]
        new_sha = r.json()["content"]["sha"]
        return safe_jsonify({
            "reply": f"✅ File save ho gayi!\n**{path}**\n🔗 {url}",
            "action": "update_file", "url": url, "repo": repo, "path": path, "sha": new_sha,
        })
    err = r.json().get("message", "Save nahi hui") if r.content else "Save nahi hui"
    return safe_jsonify({"reply": f"❌ GitHub Error: {err}", "action": "error"}), r.status_code


# ════════════════════════════════════════════════════════════════
#  BULK ACTIONS — multi-select delete/visibility-toggle from the
#  file-list / repo-list / Vercel-list UI. Two-phase like every other
#  destructive action in this app: first call (no `confirmed`) returns
#  a confirm_required prompt via build_confirmation(); the frontend's
#  existing Yes/No confirm-bubble handler already knows how to replay
#  a confirm_required response by resending with confirmed:true — no
#  new frontend confirm UI needed, bulk ops reuse the same one.
# ════════════════════════════════════════════════════════════════
BULK_CMD_MAP = {
    "delete_files": "BULK_DELETE_FILES",
    "delete_repos": "BULK_DELETE_REPOS",
    "set_repo_visibility": None,  # not destructive — no confirm needed, see below
    "delete_vercel_projects": "BULK_DELETE_VERCEL_PROJECTS",
}


@api_bp.route("/api/bulk-action", methods=["POST"])
def api_bulk_action():
    user = current_user()
    if not user:
        return safe_jsonify({"reply": "🔒 Login chahiye.", "action": "error"}), 401
    gh_token = decrypt_token(user["github_token_encrypted"])
    owner = user["github_login"]

    body = request.json or {}
    op = (body.get("op") or "").strip()
    if op not in BULK_CMD_MAP:
        return safe_jsonify({"reply": "❌ Unknown bulk action.", "action": "error"}), 400

    # ── Confirmed replay (second call, after the user tapped Yes) ──
    if body.get("confirmed"):
        cmd = body.get("pending_command")
        value = body.get("pending_value")
        token = body.get("confirm_token")
        if token != confirm_token(cmd, value, user["id"]):
            return safe_jsonify({"reply": "❌ Confirmation token match nahi hua. Dobara try kar.", "action": "error"})
        try:
            params = json.loads(value) if value else {}
        except (json.JSONDecodeError, TypeError):
            params = {}
        return safe_jsonify(_run_bulk_op(op, params, owner, gh_token, user))

    # ── set_repo_visibility is not destructive (reversible, no data loss) — runs immediately ──
    if op == "set_repo_visibility":
        repos = body.get("repos", [])
        make_private = bool(body.get("private"))
        if not repos:
            return safe_jsonify({"reply": "Koi repo select nahi kiya gaya.", "action": "warning"})
        return safe_jsonify(bulk_set_repo_visibility(repos, make_private, owner, gh_token))

    # ── First call for a destructive bulk op — build confirm prompt ──
    cmd = BULK_CMD_MAP[op]
    if op == "delete_files":
        params = {"repo": body.get("repo"), "paths": body.get("paths", [])}
        if not params["repo"] or not params["paths"]:
            return safe_jsonify({"reply": "Koi file select nahi ki gayi.", "action": "warning"})
    elif op == "delete_repos":
        params = {"repos": body.get("repos", [])}
        if not params["repos"]:
            return safe_jsonify({"reply": "Koi repo select nahi kiya gaya.", "action": "warning"})
    elif op == "delete_vercel_projects":
        params = {"projects": body.get("projects", [])}
        if not params["projects"]:
            return safe_jsonify({"reply": "Koi project select nahi kiya gaya.", "action": "warning"})
    else:
        return safe_jsonify({"reply": "❌ Unknown bulk action.", "action": "error"}), 400

    return safe_jsonify(build_confirmation(cmd, params, user["id"]))


def _run_bulk_op(op, params, owner, gh_token, user):
    if op == "delete_files":
        return bulk_delete_files(params.get("repo"), params.get("paths", []), owner, gh_token)
    if op == "delete_repos":
        return bulk_delete_repos(params.get("repos", []), owner, gh_token)
    if op == "delete_vercel_projects":
        vc_token = get_user_vercel_token(user)
        if not vc_token:
            return {"reply": "🔒 Pehle Vercel connect karo.", "action": "vercel_auth_required"}
        return bulk_delete_vercel_projects(params.get("projects", []), vc_token)
    return {"reply": "❌ Unknown bulk action.", "action": "error"}


@api_bp.route("/api/vercel/deploy-events", methods=["GET"])
def api_vercel_deploy_events():
    # Powers the slide-up live-terminal drawer in the chat UI. Polled by the
    # frontend every ~2.5s while a deployment is in progress, instead of the
    # old behaviour of just showing "Sochte hue..." until the single /chat
    # response (which already blocks server-side for up to 25s) comes back.
    # `since` lets the frontend ask for only new lines on each poll instead
    # of re-fetching + re-rendering the whole log every time.
    user = current_user()
    if not user:
        return safe_jsonify({"reply": "Session expired.", "action": "auth_required"}), 401

    vc_token = get_user_vercel_token(user)
    if not vc_token:
        return safe_jsonify({"reply": "Vercel connect nahi hai.", "action": "vercel_auth_required"}), 401

    deployment_id = (request.args.get("deployment_id") or "").strip()
    if not deployment_id:
        return safe_jsonify({"lines": [], "state": "UNKNOWN", "done": True, "error": "deployment_id required"}), 400

    since = request.args.get("since")
    events_endpoint = f"/v3/deployments/{deployment_id}/events?direction=forward&limit=300"
    if since:
        events_endpoint += f"&since={since}"

    ev_r = vc_api("GET", events_endpoint, vc_token)
    lines = []
    last_ts = int(since) if since and since.isdigit() else 0
    if ev_r.status_code == 200:
        for event in ev_r.json():
            text = (event.get("payload") or {}).get("text")
            created = event.get("created") or 0
            if text is None:
                continue
            for row in text.split("\n"):
                if row.strip():
                    lines.append(row)
            if created > last_ts:
                last_ts = created

    # Also fetch current readyState so the frontend knows when to stop
    # polling and whether to show the success/error terminal state.
    dep_r = vc_api("GET", f"/v13/deployments/{deployment_id}", vc_token)
    state = "UNKNOWN"
    live_url = None
    error_message = None
    if dep_r.status_code == 200:
        dep = dep_r.json()
        state = dep.get("readyState", "UNKNOWN")
        if state == "READY":
            raw_url = dep.get("url")
            if dep.get("aliasAssigned") and dep.get("alias"):
                live_url = f"https://{dep['alias'][0]}"
            elif raw_url:
                live_url = f"https://{raw_url}"
        if state == "ERROR":
            error_message = dep.get("errorMessage") or "Build failed."

    return safe_jsonify({
        "lines": lines,
        "since": last_ts,
        "state": state,
        "done": state in VERCEL_TERMINAL_STATES,
        "live_url": live_url,
        "error_message": error_message,
    })


ERROR_ANALYSIS_SYSTEM_PROMPT = """You are a build-log triage assistant. You are given the tail of a failed
Vercel build log. Reply in Hinglish, in at most 4 short lines total:
1. One line naming the likely root cause (be specific — package name, file, command).
2. One line with the concrete fix (a command to run, a line to change, a config to add).
Do not repeat the raw log back. Do not add disclaimers or a greeting. If the log genuinely
doesn't contain enough signal to guess a cause, say so in one line instead of inventing one."""


@api_bp.route("/api/vercel/analyze-error", methods=["POST"])
def api_vercel_analyze_error():
    # Reuses the shared OpenRouter infra (same key/model as chat + codegen)
    # to turn the raw build log tail into a short diagnosis. Only called
    # once per failed deployment by the frontend (on state===ERROR), not
    # polled, so this doesn't add meaningfully to AI usage.
    user = current_user()
    if not user:
        return safe_jsonify({"reply": "Session expired.", "action": "auth_required"}), 401

    data = request.get_json(silent=True) or {}
    lines = data.get("lines") or []
    error_message = (data.get("error_message") or "").strip()
    if not lines and not error_message:
        return safe_jsonify({"suggestion": None, "error": "no log content"}), 400

    log_tail = "\n".join(str(l) for l in lines[-60:])
    user_prompt = f"Error message: {error_message}\n\nBuild log (tail):\n{log_tail}"[:6000]

    try:
        ai_resp = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENROUTER_KEY}", "Content-Type": "application/json"},
            json={
                "model": OPENROUTER_MODEL,
                "messages": [
                    {"role": "system", "content": ERROR_ANALYSIS_SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
                "temperature": 0.2,
            },
            timeout=25,
        ).json()
        if "error" in ai_resp:
            raise RuntimeError(ai_resp["error"].get("message", "Unknown AI error"))
        suggestion = ai_resp["choices"][0]["message"]["content"].strip()
        suggestion = redact(suggestion)
        return safe_jsonify({"suggestion": suggestion})
    except Exception:
        return safe_jsonify({"suggestion": None, "error": "AI analysis abhi available nahi hai."}), 200
