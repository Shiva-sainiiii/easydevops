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
