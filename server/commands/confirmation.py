"""
DESTRUCTIVE-ACTION CONFIRMATION — the token binds (command, value,
user_id), so one user's confirm token can never be replayed to execute a
destructive action as a different user even if somehow leaked (e.g.
logged, shared in a bug report).
"""
import json
import hashlib

DESTRUCTIVE_COMMANDS = {"DELETE_REPO", "DELETE_FILE", "VERCEL_DELETE_PROJECT", "NETLIFY_DELETE_SITE", "RENDER_DELETE_SERVICE", "VERCEL_ROLLBACK"}


def confirm_token(cmd, value, user_id):
    raw = f"{cmd}:{value or ''}:{user_id}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def build_confirmation(cmd, params, user_id):
    value = json.dumps(params, sort_keys=True)
    token = confirm_token(cmd, value, user_id)
    action_verb = "delete"  # default headline verb for the confirm prompt

    if cmd == "DELETE_REPO":
        target_desc = f"GitHub repo `{params.get('repo')}`"
        warn_text = "Ye permanently delete ho jayega — saara code, history, sab kuch. Wapas nahi aayega."
    elif cmd == "DELETE_FILE":
        target_desc = f"`{params.get('path')}` in repo `{params.get('repo')}`"
        warn_text = "Ye file repo se permanently hat jayegi."
    elif cmd == "VERCEL_DELETE_PROJECT":
        target_desc = f"Vercel project `{params.get('project_name')}`"
        warn_text = "Vercel project aur uski saari deployments delete ho jayengi (GitHub repo safe rahega)."
    elif cmd == "NETLIFY_DELETE_SITE":
        target_desc = f"Netlify site `{params.get('site_name')}`"
        warn_text = "Netlify site aur uski saari deployments delete ho jayengi (GitHub repo safe rahega)."
    elif cmd == "RENDER_DELETE_SERVICE":
        target_desc = f"Render service `{params.get('service_id')}`"
        warn_text = "Service permanently delete ho jayegi — logs, deploy history, sab kuch. Wapas nahi aayega."
    elif cmd == "VERCEL_ROLLBACK":
        action_verb = "rollback"
        dep_desc = f" deployment `{params.get('deployment_id')}`" if params.get("deployment_id") else " pichli production deployment"
        target_desc = f"Vercel project `{params.get('project_name')}`"
        warn_text = (f"Live traffic{dep_desc} pe switch ho jayega — abhi ki production deployment se hat jayega. "
                     f"Naye pushes bhi tab tak auto-deploy nahi honge jab tak wapas promote na karo.")
    else:
        target_desc = str(params)
        warn_text = "Ye action wapas nahi ho sakta."

    headline = (f"{target_desc} delete karne wala hu." if action_verb == "delete"
                else f"{target_desc} ko rollback karne wala hu.")

    return {
        "reply": f"⚠️ **Pakka?**\n\n{headline}\n\n{warn_text}",
        "action": "confirm_required",
        "pending_command": cmd,
        "pending_value": value,
        "confirm_token": token,
        "confirm_verb": action_verb,
        "source": "direct",
    }
