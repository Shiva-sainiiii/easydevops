"""
PROVIDER CONNECTION ROUTES — Vercel/Netlify/Render all use manual API
token/key paste rather than OAuth. See each block's comment for why.
"""
import requests
from flask import Blueprint, request

from server.auth import current_user
from server.security import safe_jsonify
from server.db import (
    set_vercel_token, clear_vercel_token,
    set_netlify_token, clear_netlify_token,
    set_render_token, clear_render_token,
)

provider_bp = Blueprint("provider_routes", __name__)


# ════════════════════════════════════════════════════════════════
#  CLIENT-SIDE TOKEN PRE-VALIDATION (tick/cross before submit)
#
#  Same three "who am I" calls the real /connect routes already make,
#  just exposed standalone and read-only — no DB write, no session
#  requirement beyond being logged into GitHub (these tokens aren't
#  saved anywhere by this endpoint). The frontend debounces calls to
#  this as the user types/pastes into the token field, so a bad paste
#  shows a ✗ immediately instead of only failing after the user hits
#  Connect and round-trips through the real /connect route.
#
#  Deliberately separate from /connect rather than a shared helper with
#  a "dry_run" flag — keeping the actual token-saving path free of any
#  validate-only branching is worth the small duplication of the three
#  short whoami calls below.
# ════════════════════════════════════════════════════════════════
_VALIDATE_ENDPOINTS = {
    "vercel": ("https://api.vercel.com/v2/user", lambda j: j.get("user", {}).get("username") or j.get("user", {}).get("email")),
    "netlify": ("https://api.netlify.com/api/v1/user", lambda j: j.get("email") or j.get("full_name")),
    "render": ("https://api.render.com/v1/users", lambda j: (j[0] if isinstance(j, list) and j else j if isinstance(j, dict) else {}).get("email") or (j[0] if isinstance(j, list) and j else j if isinstance(j, dict) else {}).get("name")),
}


@provider_bp.route("/api/<provider>/validate", methods=["POST"])
def validate_provider_token(provider):
    user = current_user()
    if not user:
        return safe_jsonify({"valid": False, "reason": "not_logged_in"}), 401

    if provider not in _VALIDATE_ENDPOINTS:
        return safe_jsonify({"valid": False, "reason": "unknown_provider"}), 400

    body = request.json or {}
    token = (body.get("token") or "").strip()
    if not token:
        return safe_jsonify({"valid": False, "reason": "empty"})

    url, extract_label = _VALIDATE_ENDPOINTS[provider]
    try:
        r = requests.get(
            url,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            timeout=10,
        )
    except requests.RequestException:
        # Network hiccup talking to the provider shouldn't be shown as
        # "invalid token" — the frontend treats this as inconclusive and
        # just doesn't show a tick/cross yet, letting the real /connect
        # call on submit be the final word.
        return safe_jsonify({"valid": None, "reason": "network_error"})

    if r.status_code != 200:
        return safe_jsonify({"valid": False, "reason": "rejected"})

    try:
        label = extract_label(r.json())
    except Exception:
        label = None
    return safe_jsonify({"valid": True, "label": label})


# ════════════════════════════════════════════════════════════════
#  VERCEL CONNECTION — manual API token paste (not OAuth).
#
#  WHY MANUAL TOKEN INSTEAD OF OAUTH:
#  Vercel's "Sign in with Vercel" OAuth flow is identity-focused (scopes:
#  openid, email, profile, offline_access) and its documentation does not
#  clearly cover deployment/project-management API access — as of writing,
#  Vercel's own community forum has an open, unanswered thread from another
#  developer asking exactly this question. Rather than build a PKCE +
#  refresh-token OAuth flow on an assumption that might not hold, users
#  paste a personal access token they generate themselves in their Vercel
#  dashboard (Settings -> Tokens). This is guaranteed to have real API
#  access since it's the same token type Vercel's own docs use for direct
#  API calls, and the user can revoke it anytime from their own dashboard.
# ════════════════════════════════════════════════════════════════
@provider_bp.route("/api/vercel/connect", methods=["POST"])
def vercel_connect():
    user = current_user()
    if not user:
        return safe_jsonify({"reply": "🔒 Pehle GitHub se connect karo.", "action": "auth_required"}), 401

    body = request.json or {}
    token = (body.get("token") or "").strip()
    if not token:
        return safe_jsonify({"reply": "❌ Token khaali hai.", "action": "error"}), 400

    # Validate the token actually works before saving it — a quick call to
    # Vercel's own "who am I" endpoint. This also gives us the Vercel
    # username to display, and catches typos/expired-token paste mistakes
    # immediately instead of failing later on the first real command.
    r = requests.get(
        "https://api.vercel.com/v2/user",
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    if r.status_code != 200:
        return safe_jsonify({
            "reply": "❌ Ye token valid nahi hai. Vercel dashboard se dubara copy karke try karo.",
            "action": "error"
        }), 400

    vercel_user = r.json().get("user", {})
    vercel_username = vercel_user.get("username") or vercel_user.get("email") or "connected"

    set_vercel_token(user["id"], token, vercel_username)
    return safe_jsonify({"ok": True, "vercel_username": vercel_username})


@provider_bp.route("/api/vercel/disconnect", methods=["POST"])
def vercel_disconnect():
    user = current_user()
    if not user:
        return safe_jsonify({"reply": "🔒 Pehle GitHub se connect karo.", "action": "auth_required"}), 401
    clear_vercel_token(user["id"])
    return safe_jsonify({"ok": True})


# ════════════════════════════════════════════════════════════════
#  NETLIFY CONNECTION — manual API token paste, same reasoning as Vercel.
#  Netlify does support a "public integration" OAuth2 flow, but per their
#  own docs that's meant for apps built for OTHER people's Netlify accounts
#  at scale (needs a registered OAuth app + client secret exchange), while
#  Personal Access Tokens are their own documented, first-class path for
#  "manual authentication in shell scripts or commands that use the Netlify
#  API" — exactly this use case. Guaranteed real API access, no ambiguity.
# ════════════════════════════════════════════════════════════════
@provider_bp.route("/api/netlify/connect", methods=["POST"])
def netlify_connect():
    user = current_user()
    if not user:
        return safe_jsonify({"reply": "🔒 Pehle GitHub se connect karo.", "action": "auth_required"}), 401

    body = request.json or {}
    token = (body.get("token") or "").strip()
    if not token:
        return safe_jsonify({"reply": "❌ Token khaali hai.", "action": "error"}), 400

    # Validate against Netlify's own "who am I" endpoint before saving.
    r = requests.get(
        "https://api.netlify.com/api/v1/user",
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    if r.status_code != 200:
        return safe_jsonify({
            "reply": "❌ Ye token valid nahi hai. Netlify dashboard se dubara copy karke try karo.",
            "action": "error"
        }), 400

    netlify_user = r.json()
    netlify_email = netlify_user.get("email") or netlify_user.get("full_name") or "connected"

    set_netlify_token(user["id"], token, netlify_email)
    return safe_jsonify({"ok": True, "netlify_email": netlify_email})


@provider_bp.route("/api/netlify/disconnect", methods=["POST"])
def netlify_disconnect():
    user = current_user()
    if not user:
        return safe_jsonify({"reply": "🔒 Pehle GitHub se connect karo.", "action": "auth_required"}), 401
    clear_netlify_token(user["id"])
    return safe_jsonify({"ok": True})


# ════════════════════════════════════════════════════════════════
#  RENDER CONNECTION — manual API key paste, same reasoning as Vercel
#  and Netlify. Render has NO public OAuth flow at all (confirmed via
#  their own docs — API keys, created in Account Settings, are the only
#  documented auth path for third-party tools), so this is the only
#  option here, not just the preferred one.
# ════════════════════════════════════════════════════════════════
@provider_bp.route("/api/render/connect", methods=["POST"])
def render_connect():
    user = current_user()
    if not user:
        return safe_jsonify({"reply": "🔒 Pehle GitHub se connect karo.", "action": "auth_required"}), 401

    body = request.json or {}
    token = (body.get("token") or "").strip()
    if not token:
        return safe_jsonify({"reply": "❌ Token khaali hai.", "action": "error"}), 400

    # Validate against Render's own "who am I" endpoint before saving.
    r = requests.get(
        "https://api.render.com/v1/users",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        timeout=15,
    )
    if r.status_code != 200:
        return safe_jsonify({
            "reply": "❌ Ye API key valid nahi hai. Render dashboard se dubara copy karke try karo.",
            "action": "error"
        }), 400

    render_user = r.json()
    # Response shape can be a bare user object or a list depending on key
    # scope — handle both defensively rather than assuming one shape.
    if isinstance(render_user, list):
        render_user = render_user[0] if render_user else {}
    render_email = render_user.get("email") or render_user.get("name") or "connected"

    set_render_token(user["id"], token, render_email)
    return safe_jsonify({"ok": True, "render_email": render_email})


@provider_bp.route("/api/render/disconnect", methods=["POST"])
def render_disconnect():
    user = current_user()
    if not user:
        return safe_jsonify({"reply": "🔒 Pehle GitHub se connect karo.", "action": "auth_required"}), 401
    clear_render_token(user["id"])
    return safe_jsonify({"ok": True})
