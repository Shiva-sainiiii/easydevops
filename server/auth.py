"""
AUTH — stateless signed-cookie sessions + per-request user lookup.

Session cookie carries only `user_id`, signed (not encrypted) with
itsdangerous — that's enough since the cookie holds no sensitive data
itself, just a pointer into the users table (see server/db.py) where the
real secrets live encrypted. A separate OAuth-state cookie (short-lived,
10 min) carries the CSRF state value across the GitHub redirect
round-trip, replacing what would otherwise be a server-side session.
"""
from flask import request
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

from server.config import FLASK_SECRET_KEY, IS_PROD
from server.db import get_user_by_id

# Two separate "salts" keep the OAuth CSRF-state cookie and the login
# session cookie cryptographically independent, even though both are
# signed with the same underlying FLASK_SECRET_KEY.
_session_signer = URLSafeTimedSerializer(FLASK_SECRET_KEY, salt="agent-session")
_oauth_state_signer = URLSafeTimedSerializer(FLASK_SECRET_KEY, salt="agent-oauth-state")

SESSION_COOKIE_NAME = "agent_session"
OAUTH_STATE_COOKIE_NAME = "agent_oauth_state"
SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30  # 30 days
OAUTH_STATE_MAX_AGE_SECONDS = 60 * 10        # 10 minutes — just needs to survive the redirect round-trip


def _cookie_kwargs(max_age):
    return dict(
        httponly=True,
        samesite="Lax",   # Lax (not Strict) so the cookie rides along on GitHub's redirect back to us
        secure=IS_PROD,
        max_age=max_age,
        path="/",
    )


def set_session_cookie(resp, user_id):
    token = _session_signer.dumps({"user_id": user_id})
    resp.set_cookie(SESSION_COOKIE_NAME, token, **_cookie_kwargs(SESSION_MAX_AGE_SECONDS))


def clear_session_cookie(resp):
    resp.delete_cookie(SESSION_COOKIE_NAME, path="/")


def read_session_user_id():
    """Verifies the signed session cookie and returns the user_id inside it,
    or None if missing/invalid/expired. Pure signature check — no DB hit."""
    raw = request.cookies.get(SESSION_COOKIE_NAME)
    if not raw:
        return None
    try:
        data = _session_signer.loads(raw, max_age=SESSION_MAX_AGE_SECONDS)
        return data.get("user_id")
    except (BadSignature, SignatureExpired):
        return None


def set_oauth_state_cookie(resp, state):
    token = _oauth_state_signer.dumps({"state": state})
    resp.set_cookie(OAUTH_STATE_COOKIE_NAME, token, **_cookie_kwargs(OAUTH_STATE_MAX_AGE_SECONDS))


def read_and_clear_oauth_state_cookie(resp):
    """Reads the expected state from its signed cookie and schedules the
    cookie for deletion on the given response (single-use, like the old
    session.pop() did)."""
    raw = request.cookies.get(OAUTH_STATE_COOKIE_NAME)
    resp.delete_cookie(OAUTH_STATE_COOKIE_NAME, path="/")
    if not raw:
        return None
    try:
        data = _oauth_state_signer.loads(raw, max_age=OAUTH_STATE_MAX_AGE_SECONDS)
        return data.get("state")
    except (BadSignature, SignatureExpired):
        return None


def current_user():
    """Returns the logged-in user's DB row (dict) or None. Reads from the
    signed session cookie — never trusts anything client-supplied beyond
    that cookie's signature, which is verified against FLASK_SECRET_KEY."""
    user_id = read_session_user_id()
    if not user_id:
        return None
    return get_user_by_id(user_id)


def require_login():
    """Returns an error dict if not logged in, else None. Route handlers
    check `if (err := require_login()): return err` style.

    Imports safe_jsonify lazily (not at module load) to avoid a circular
    import: server.security.safe_jsonify itself calls current_user() from
    this module, so security.py imports auth.py — auth.py can't also
    import security.py at module level without a cycle.
    """
    if not current_user():
        from server.security import safe_jsonify
        return safe_jsonify({
            "reply": "🔒 Pehle GitHub se connect karo. Login button dabao.",
            "action": "auth_required"
        }), 401
    return None
