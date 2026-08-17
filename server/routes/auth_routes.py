"""
GITHUB OAUTH FLOW — login redirect, callback, logout, and /api/me (the
frontend's "am I logged in" check).
"""
import secrets
import requests
from flask import Blueprint, request, redirect, make_response

from server.config import APP_BASE_URL, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
from server.auth import (
    set_oauth_state_cookie, read_and_clear_oauth_state_cookie,
    set_session_cookie, clear_session_cookie, current_user,
)
from server.db import upsert_user, delete_user
from server.security import safe_jsonify

auth_bp = Blueprint("auth_routes", __name__)

GITHUB_OAUTH_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
GITHUB_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token"
# Scopes: 'repo' = full read/write on repos (needed for create/delete/file
# edits, including private repos). 'delete_repo' is a SEPARATE scope GitHub
# requires specifically for repo deletion — 'repo' alone can't delete repos.
GITHUB_OAUTH_SCOPES = "repo,delete_repo"


@auth_bp.route("/auth/github/login")
def github_login():
    state = secrets.token_urlsafe(24)
    redirect_uri = f"{APP_BASE_URL}/auth/github/callback"
    params = {
        "client_id": GITHUB_CLIENT_ID,
        "redirect_uri": redirect_uri,
        "scope": GITHUB_OAUTH_SCOPES,
        "state": state,
        "allow_signup": "true",
    }
    query = "&".join(f"{k}={requests.utils.quote(str(v))}" for k, v in params.items())
    resp = make_response(redirect(f"{GITHUB_OAUTH_AUTHORIZE_URL}?{query}"))
    set_oauth_state_cookie(resp, state)
    return resp


@auth_bp.route("/auth/github/callback")
def github_callback():
    error = request.args.get("error")
    if error:
        return redirect(f"/?auth_error={error}")

    # Build the eventual redirect response up front so we can attach the
    # (now-consumed) oauth-state cookie deletion to it regardless of which
    # branch below we take.
    redirect_resp = make_response(redirect("/"))
    returned_state = request.args.get("state")
    expected_state = read_and_clear_oauth_state_cookie(redirect_resp)
    if not returned_state or not expected_state or returned_state != expected_state:
        return redirect("/?auth_error=state_mismatch")

    code = request.args.get("code")
    if not code:
        return redirect("/?auth_error=no_code")

    token_r = requests.post(
        GITHUB_OAUTH_TOKEN_URL,
        headers={"Accept": "application/json"},
        data={
            "client_id": GITHUB_CLIENT_ID,
            "client_secret": GITHUB_CLIENT_SECRET,
            "code": code,
            "redirect_uri": f"{APP_BASE_URL}/auth/github/callback",
        },
        timeout=15,
    )
    token_data = token_r.json()
    access_token = token_data.get("access_token")
    if not access_token:
        return redirect(f"/?auth_error={token_data.get('error', 'token_exchange_failed')}")

    # Fetch the identity this token belongs to — this is what scopes the
    # token to a specific user in our DB (github_id is the stable key,
    # not login, since usernames can change).
    who_r = requests.get(
        "https://api.github.com/user",
        headers={"Authorization": f"Bearer {access_token}", "Accept": "application/vnd.github+json"},
        timeout=15,
    )
    if who_r.status_code != 200:
        return redirect("/?auth_error=identity_fetch_failed")

    who = who_r.json()
    user_id = upsert_user(
        github_id=who["id"],
        github_login=who["login"],
        avatar_url=who.get("avatar_url"),
        github_token=access_token,
    )

    set_session_cookie(redirect_resp, user_id)
    return redirect_resp


@auth_bp.route("/auth/logout", methods=["POST"])
def logout():
    user = current_user()
    if user:
        delete_user(user["id"])
    resp = safe_jsonify({"ok": True})
    resp = make_response(resp)
    clear_session_cookie(resp)
    return resp


@auth_bp.route("/api/me")
def api_me():
    user = current_user()
    if not user:
        return safe_jsonify({"logged_in": False})
    return safe_jsonify({
        "logged_in": True,
        "login": user["github_login"],
        "avatar_url": user["avatar_url"],
        "vercel_connected": bool(user.get("vercel_token_encrypted")),
        "vercel_username": user.get("vercel_username"),
        "netlify_connected": bool(user.get("netlify_token_encrypted")),
        "netlify_email": user.get("netlify_email"),
        "render_connected": bool(user.get("render_token_encrypted")),
        "render_email": user.get("render_email"),
    })
