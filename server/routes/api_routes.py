"""
Misc JSON API routes consumed by the frontend for autofill/live-data:
repo names, repo folders, repo files (all power the command-form
dropdowns), plus the Vercel live-build-log polling endpoint and the
AI error-analysis endpoint used by the deploy terminal drawer.
"""
import requests
from flask import Blueprint, request

from server.config import OPENROUTER_KEY
from server.auth import current_user
from server.db import decrypt_token, get_user_vercel_token
from server.security import safe_jsonify, redact
from server.providers.github import gh_api
from server.providers.vercel import vc_api, VERCEL_TERMINAL_STATES
from server.commands.ai_fallback import OPENROUTER_MODEL

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
