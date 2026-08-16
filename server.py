from flask import Flask, request, jsonify, send_from_directory, redirect, make_response
from flask_cors import CORS
import requests
import os
import base64
import json
import re
import time
import hashlib
import secrets
import psycopg2
import psycopg2.extras
from contextlib import contextmanager
from cryptography.fernet import Fernet, InvalidToken
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
CORS(app, supports_credentials=True)

# ════════════════════════════════════════════════════════════════
#  APP-LEVEL CONFIG
#  These are the ONLY secrets that live in this server's own env —
#  they identify the *app itself* to GitHub's OAuth system, not any
#  individual user. No user's GitHub/Vercel/Render token ever goes
#  in an env var; those are per-user and stored encrypted in Postgres
#  (see TOKEN STORE below).
#
#  WHY POSTGRES + SIGNED COOKIES INSTEAD OF SQLITE + SERVER SESSIONS:
#  Vercel runs this app as serverless functions — every request gets a
#  fresh, isolated filesystem with no shared memory or disk between
#  invocations. A SQLite file written during one request is gone by
#  the next; Flask's default server-side session (which also needs
#  somewhere persistent to live) has the same problem. So:
#    - Token storage moves to Neon (managed Postgres) — a real network
#      database that persists independently of any single invocation.
#    - The session itself becomes STATELESS: instead of storing
#      "user_id" server-side and giving the browser an opaque pointer
#      to it, we put the user_id directly in the cookie, signed with
#      itsdangerous so it can't be forged or tampered with. No server
#      lookup needed to know who's asking — just signature verification.
# ════════════════════════════════════════════════════════════════
FLASK_SECRET_KEY   = os.getenv("FLASK_SECRET_KEY")          # signs the session cookie
FERNET_KEY         = os.getenv("FERNET_KEY")                # encrypts tokens at rest in postgres
GITHUB_CLIENT_ID   = os.getenv("GITHUB_CLIENT_ID")
GITHUB_CLIENT_SECRET = os.getenv("GITHUB_CLIENT_SECRET")
OPENROUTER_KEY     = os.getenv("OPENROUTER_KEY")            # still app-level: AI fallback is shared infra, not per-user
APP_BASE_URL       = os.getenv("APP_BASE_URL", "http://localhost:5000")  # used to build the OAuth callback URL
DATABASE_URL       = os.getenv("DATABASE_URL")              # Neon Postgres connection string

if not FLASK_SECRET_KEY:
    raise RuntimeError("FLASK_SECRET_KEY env var missing — required to sign session cookies. Generate one with: python -c \"import secrets; print(secrets.token_hex(32))\"")
if not FERNET_KEY:
    raise RuntimeError("FERNET_KEY env var missing — required to encrypt stored tokens. Generate one with: python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\"")
if not GITHUB_CLIENT_ID or not GITHUB_CLIENT_SECRET:
    raise RuntimeError("GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET missing — register a GitHub OAuth App and set these.")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL env var missing — set this to your Neon Postgres connection string.")

app.secret_key = FLASK_SECRET_KEY
fernet = Fernet(FERNET_KEY.encode() if isinstance(FERNET_KEY, str) else FERNET_KEY)

IS_PROD = os.getenv("FLASK_ENV") != "development"

# ── Cookie signer for stateless sessions ──
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


# ════════════════════════════════════════════════════════════════
#  TOKEN STORE — Neon Postgres, encrypted at rest
#  One row per logged-in user: their GitHub identity + their
#  ENCRYPTED GitHub access token. Nothing here is readable without
#  FERNET_KEY, which lives only in this server's env — but the point
#  of this whole rewrite is that even that key only decrypts *tokens
#  users voluntarily connected*, never a shared credential of yours.
# ════════════════════════════════════════════════════════════════
@contextmanager
def db():
    # A fresh connection per request is the right call in a serverless
    # environment — there's no long-lived process to hold a pool across
    # invocations. Neon's connection overhead is small and it's designed
    # for exactly this pattern (it even offers a pooled connection string
    # for high-concurrency cases — see README).
    conn = psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    github_id BIGINT UNIQUE NOT NULL,
                    github_login TEXT NOT NULL,
                    avatar_url TEXT,
                    github_token_encrypted BYTEA NOT NULL,
                    vercel_token_encrypted BYTEA,
                    vercel_username TEXT,
                    netlify_token_encrypted BYTEA,
                    netlify_email TEXT,
                    render_token_encrypted BYTEA,
                    render_email TEXT,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                )
            """)
            # Migration-safe: if this table already existed from before Vercel/
            # Netlify/Render support was added, ALTER it rather than relying on
            # CREATE TABLE IF NOT EXISTS (which only applies to brand-new tables).
            cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS vercel_token_encrypted BYTEA")
            cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS vercel_username TEXT")
            cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS netlify_token_encrypted BYTEA")
            cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS netlify_email TEXT")
            cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS render_token_encrypted BYTEA")
            cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS render_email TEXT")


init_db()


def encrypt_token(raw_token):
    return fernet.encrypt(raw_token.encode())


def decrypt_token(blob):
    try:
        # psycopg2 returns BYTEA as memoryview/bytes depending on driver version
        raw_bytes = bytes(blob) if not isinstance(blob, bytes) else blob
        return fernet.decrypt(raw_bytes).decode()
    except InvalidToken:
        return None


def upsert_user(github_id, github_login, avatar_url, github_token):
    encrypted = encrypt_token(github_token)
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO users (github_id, github_login, avatar_url, github_token_encrypted)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (github_id) DO UPDATE SET
                    github_login = EXCLUDED.github_login,
                    avatar_url = EXCLUDED.avatar_url,
                    github_token_encrypted = EXCLUDED.github_token_encrypted,
                    updated_at = NOW()
                RETURNING id
            """, (github_id, github_login, avatar_url, encrypted))
            row = cur.fetchone()
            return row["id"]


def get_user_by_id(user_id):
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM users WHERE id = %s", (user_id,))
            row = cur.fetchone()
            return dict(row) if row else None


def get_user_github_token(user_id):
    user = get_user_by_id(user_id)
    if not user:
        return None
    return decrypt_token(user["github_token_encrypted"])


def delete_user(user_id):
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM users WHERE id = %s", (user_id,))


def set_vercel_token(user_id, vercel_token, vercel_username):
    """Stores the user's pasted Vercel API token, encrypted, alongside their
    GitHub identity row. Vercel connection is optional and independent of
    GitHub login — a user can be logged in via GitHub with no Vercel token
    set at all, in which case Vercel commands should prompt them to connect."""
    encrypted = encrypt_token(vercel_token)
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE users SET
                    vercel_token_encrypted = %s,
                    vercel_username = %s,
                    updated_at = NOW()
                WHERE id = %s
            """, (encrypted, vercel_username, user_id))


def clear_vercel_token(user_id):
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE users SET
                    vercel_token_encrypted = NULL,
                    vercel_username = NULL,
                    updated_at = NOW()
                WHERE id = %s
            """, (user_id,))


def get_user_vercel_token(user):
    """Given an already-fetched user row (dict), decrypts and returns their
    Vercel token, or None if they haven't connected Vercel."""
    blob = user.get("vercel_token_encrypted")
    if not blob:
        return None
    return decrypt_token(blob)


def set_netlify_token(user_id, netlify_token, netlify_email):
    """Same pattern as set_vercel_token — Netlify connection is also optional
    and independent of GitHub/Vercel."""
    encrypted = encrypt_token(netlify_token)
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE users SET
                    netlify_token_encrypted = %s,
                    netlify_email = %s,
                    updated_at = NOW()
                WHERE id = %s
            """, (encrypted, netlify_email, user_id))


def clear_netlify_token(user_id):
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE users SET
                    netlify_token_encrypted = NULL,
                    netlify_email = NULL,
                    updated_at = NOW()
                WHERE id = %s
            """, (user_id,))


def get_user_netlify_token(user):
    blob = user.get("netlify_token_encrypted")
    if not blob:
        return None
    return decrypt_token(blob)


def set_render_token(user_id, render_token, render_email):
    """Same pattern as set_vercel_token/set_netlify_token."""
    encrypted = encrypt_token(render_token)
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE users SET
                    render_token_encrypted = %s,
                    render_email = %s,
                    updated_at = NOW()
                WHERE id = %s
            """, (encrypted, render_email, user_id))


def clear_render_token(user_id):
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE users SET
                    render_token_encrypted = NULL,
                    render_email = NULL,
                    updated_at = NOW()
                WHERE id = %s
            """, (user_id,))


def get_user_render_token(user):
    blob = user.get("render_token_encrypted")
    if not blob:
        return None
    return decrypt_token(blob)


# ════════════════════════════════════════════════════════════════
#  AUTH HELPERS
# ════════════════════════════════════════════════════════════════
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
    check `if (err := require_login()): return err` style."""
    if not current_user():
        return safe_jsonify({
            "reply": "🔒 Pehle GitHub se connect karo. Login button dabao.",
            "action": "auth_required"
        }), 401
    return None


# ════════════════════════════════════════════════════════════════
#  SECRET REDACTION — defense in depth.
#  Same idea as the single-user version, but now scrubs whatever the
#  CURRENT REQUEST's user token looks like — since tokens are now
#  per-user and not fixed at startup, we redact by pattern shape
#  (GitHub PAT/OAuth token formats) rather than a fixed known list,
#  plus whatever token was actually used to serve this request.
# ════════════════════════════════════════════════════════════════
_SECRET_PATTERNS = [
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"gho_[A-Za-z0-9]{20,}"),          # OAuth-issued GitHub tokens use this prefix
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"sk-or-v1-[A-Za-z0-9]{20,}"),
    re.compile(r"sk-[A-Za-z0-9]{20,}"),
    re.compile(r"Bearer\s+[A-Za-z0-9\-_\.]{15,}", re.I),
    re.compile(r"rnd_[A-Za-z0-9]{20,}"),
]

_APP_SECRETS = [s for s in [GITHUB_CLIENT_SECRET, OPENROUTER_KEY, FERNET_KEY, FLASK_SECRET_KEY, DATABASE_URL] if s]


def redact(text, extra_secrets=None):
    """Remove app-level secrets, the current request's user token (if any),
    and any secret-shaped strings from outbound text."""
    if not text:
        return text
    secrets_to_scrub = list(_APP_SECRETS) + list(extra_secrets or [])
    for secret in secrets_to_scrub:
        if secret and len(secret) > 6:
            text = text.replace(secret, "[REDACTED]")
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub("[REDACTED]", text)
    return text


def safe_jsonify(payload):
    """jsonify() wrapper that redacts every string value in the response
    payload before it leaves the server."""
    user = current_user()
    extra = []
    if user:
        gh_tok = decrypt_token(user["github_token_encrypted"])
        if gh_tok:
            extra.append(gh_tok)
        vc_tok = get_user_vercel_token(user)
        if vc_tok:
            extra.append(vc_tok)
        nl_tok = get_user_netlify_token(user)
        if nl_tok:
            extra.append(nl_tok)
        rd_tok = get_user_render_token(user)
        if rd_tok:
            extra.append(rd_tok)

    def scrub(obj):
        if isinstance(obj, str):
            return redact(obj, extra_secrets=extra)
        if isinstance(obj, dict):
            return {k: scrub(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [scrub(v) for v in obj]
        return obj
    return jsonify(scrub(payload))


# ════════════════════════════════════════════════════════════════
#  GITHUB OAUTH FLOW
# ════════════════════════════════════════════════════════════════
GITHUB_OAUTH_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
GITHUB_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token"
# Scopes: 'repo' = full read/write on repos (needed for create/delete/file
# edits, including private repos). 'delete_repo' is a SEPARATE scope GitHub
# requires specifically for repo deletion — 'repo' alone can't delete repos.
GITHUB_OAUTH_SCOPES = "repo,delete_repo"


@app.route("/auth/github/login")
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


@app.route("/auth/github/callback")
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


@app.route("/auth/logout", methods=["POST"])
def logout():
    user = current_user()
    if user:
        delete_user(user["id"])
    resp = safe_jsonify({"ok": True})
    resp = make_response(resp)
    clear_session_cookie(resp)
    return resp


@app.route("/api/me")
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
@app.route("/api/vercel/connect", methods=["POST"])
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


@app.route("/api/vercel/disconnect", methods=["POST"])
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
@app.route("/api/netlify/connect", methods=["POST"])
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


@app.route("/api/netlify/disconnect", methods=["POST"])
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
@app.route("/api/render/connect", methods=["POST"])
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


@app.route("/api/render/disconnect", methods=["POST"])
def render_disconnect():
    user = current_user()
    if not user:
        return safe_jsonify({"reply": "🔒 Pehle GitHub se connect karo.", "action": "auth_required"}), 401
    clear_render_token(user["id"])
    return safe_jsonify({"ok": True})


def gh_api(method, endpoint, gh_token, **kwargs):
    url = f"https://api.github.com{endpoint}"
    headers = {
        "Authorization": f"Bearer {gh_token}",
        "Accept": "application/vnd.github+json",
    }
    return requests.request(method, url, headers=headers, timeout=20, **kwargs)


def vc_api(method, endpoint, vc_token, **kwargs):
    url = f"https://api.vercel.com{endpoint}"
    headers = {
        "Authorization": f"Bearer {vc_token}",
        "Content-Type": "application/json",
    }
    return requests.request(method, url, headers=headers, timeout=20, **kwargs)


def nl_api(method, endpoint, nl_token, **kwargs):
    url = f"https://api.netlify.com/api/v1{endpoint}"
    headers = {
        "Authorization": f"Bearer {nl_token}",
        "Content-Type": "application/json",
    }
    return requests.request(method, url, headers=headers, timeout=20, **kwargs)


def rd_api(method, endpoint, rd_token, **kwargs):
    url = f"https://api.render.com/v1{endpoint}"
    headers = {
        "Authorization": f"Bearer {rd_token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    return requests.request(method, url, headers=headers, timeout=20, **kwargs)


def netlify_find_site(site_name, nl_token):
    """Netlify site IDs and names/subdomains are interchangeable in API
    paths per their docs, but we still resolve to a full site object first
    so callers have the real site_id (needed for some endpoints like env
    vars, which key off account_id, not site_id, so this also gives us
    that context)."""
    r = nl_api("GET", f"/sites/{site_name}", nl_token)
    if r.status_code == 200:
        return r.json()
    return None


def vercel_find_project(project_name, vc_token):
    r = vc_api("GET", "/v9/projects", vc_token)
    if r.status_code != 200:
        return None
    for p in r.json().get("projects", []):
        if p.get("name") == project_name:
            return p
    return None


VERCEL_TERMINAL_STATES = {"READY", "ERROR", "CANCELED"}


def vercel_poll_deployment(deployment_id, vc_token, max_wait_seconds=25, interval_seconds=3):
    """Poll GET /v13/deployments/{id} until terminal readyState or timeout.
    Short timeout since this runs synchronously inside one request — Vercel
    serverless functions also have their own execution time limits, so this
    deliberately doesn't try to wait indefinitely for a slow build."""
    elapsed = 0
    last_dep = {}
    while elapsed <= max_wait_seconds:
        r = vc_api("GET", f"/v13/deployments/{deployment_id}", vc_token)
        if r.status_code != 200:
            time.sleep(interval_seconds)
            elapsed += interval_seconds
            continue

        dep = r.json()
        last_dep = dep
        state = dep.get("readyState", "UNKNOWN")

        if state in VERCEL_TERMINAL_STATES:
            live_url = None
            if state == "READY":
                raw_url = dep.get("url")
                if raw_url:
                    live_url = f"https://{raw_url}"
                if dep.get("aliasAssigned") and dep.get("alias"):
                    live_url = f"https://{dep['alias'][0]}"
            return {"ok": state == "READY", "timed_out": False, "deployment": dep, "state": state, "live_url": live_url}

        time.sleep(interval_seconds)
        elapsed += interval_seconds

    return {"ok": False, "timed_out": True, "deployment": last_dep, "state": last_dep.get("readyState", "UNKNOWN"), "live_url": None}


def get_file_sha(repo, path, owner, gh_token):
    r = gh_api("GET", f"/repos/{owner}/{repo}/contents/{path}", gh_token)
    if r.status_code == 200:
        return r.json().get("sha")
    return None


# ════════════════════════════════════════════════════════════════
#  DESTRUCTIVE-ACTION CONFIRMATION
#  Same pattern as the single-user version, but the token binds
#  (command, value, user_id) — so one user's confirm token can never
#  be replayed to execute a destructive action as a different user
#  even if somehow leaked (e.g. logged, shared in a bug report).
# ════════════════════════════════════════════════════════════════
DESTRUCTIVE_COMMANDS = {"DELETE_REPO", "DELETE_FILE", "VERCEL_DELETE_PROJECT", "NETLIFY_DELETE_SITE", "RENDER_DELETE_SERVICE"}


def confirm_token(cmd, value, user_id):
    raw = f"{cmd}:{value or ''}:{user_id}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def build_confirmation(cmd, params, user_id):
    value = json.dumps(params, sort_keys=True)
    token = confirm_token(cmd, value, user_id)

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
    else:
        target_desc = str(params)
        warn_text = "Ye action wapas nahi ho sakta."

    return {
        "reply": f"⚠️ **Pakka?**\n\n{target_desc} delete karne wala hu.\n\n{warn_text}",
        "action": "confirm_required",
        "pending_command": cmd,
        "pending_value": value,
        "confirm_token": token,
        "source": "direct",
    }


# ════════════════════════════════════════════════════════════════
#  execute_command — per-user executor.
#  `owner` is always the logged-in user's own GitHub login — commands
#  never take an arbitrary owner from the request, so there's no way
#  to point one user's token at another user's namespace by accident
#  (GitHub would reject cross-account writes anyway, but this keeps
#  reads scoped correctly too).
# ════════════════════════════════════════════════════════════════
def execute_command(cmd, params, owner, gh_token, vc_token=None, nl_token=None, rd_token=None):
    params = params or {}

    try:
        if cmd == "CREATE_REPO":
            repo_name = re.sub(r"[^a-zA-Z0-9_.-]", "-", params["repo"].strip())
            r = gh_api("POST", "/user/repos", gh_token, json={"name": repo_name, "private": False, "auto_init": True})
            if r.status_code == 201:
                data = r.json()
                return {"reply": f"✅ Repo ban gaya!\n**{repo_name}**\n🔗 {data['html_url']}",
                        "action": "create_repo", "url": data["html_url"], "repo": repo_name}
            elif r.status_code == 422:
                return {"reply": f"⚠️ Repo `{repo_name}` already exist karta hai.", "action": "warning"}
            else:
                return {"reply": f"❌ GitHub Error: {r.json().get('message', 'Repo nahi bana')}", "action": "error"}

        elif cmd == "DELETE_REPO":
            repo_name = params["repo"].strip()
            r = gh_api("DELETE", f"/repos/{owner}/{repo_name}", gh_token)
            if r.status_code == 204:
                return {"reply": f"🗑️ Repo `{repo_name}` delete ho gaya.", "action": "delete_repo"}
            else:
                msg = r.json().get("message", "Repo delete nahi hua") if r.content else "Repo delete nahi hua"
                if r.status_code == 403:
                    msg += " (Hint: OAuth token me `delete_repo` scope chahiye — dubara login/reconnect karke try karo.)"
                return {"reply": f"❌ Delete Error: {msg}", "action": "error"}

        elif cmd == "LIST_REPOS":
            r = gh_api("GET", f"/user/repos?per_page=20&sort=updated&affiliation=owner", gh_token)
            if r.status_code == 200:
                repos = r.json()
                if not repos:
                    return {"reply": "Koi repo nahi hai abhi.", "action": "list_repos", "repos": []}
                lines = [f"📁 **{rp['name']}** — ⭐{rp['stargazers_count']} — `{rp['visibility']}`\n🔗 {rp['html_url']}" for rp in repos]
                # Extra fields below (stars/visibility/language/fork/updated_at)
                # are only used by the frontend's compact activity-card
                # renderer — the markdown `reply` above stays the fallback
                # for older clients / the AI-narration path.
                return {"reply": f"Tere {len(repos)} repos:\n\n" + "\n\n".join(lines), "action": "list_repos",
                        "repos": [{
                            "name": rp["name"], "url": rp["html_url"],
                            "stars": rp.get("stargazers_count", 0),
                            "visibility": rp.get("visibility", "public"),
                            "language": rp.get("language"),
                            "fork": rp.get("fork", False),
                            "updated_at": rp.get("updated_at"),
                        } for rp in repos]}
            else:
                return {"reply": "❌ Repos fetch nahi hue.", "action": "error"}

        elif cmd == "LIST_FILES":
            repo = params["repo"]
            path = params.get("path", "").strip("/")
            endpoint = f"/repos/{owner}/{repo}/contents/{path}" if path else f"/repos/{owner}/{repo}/contents"
            r = gh_api("GET", endpoint, gh_token)
            if r.status_code == 200:
                items = r.json()
                if not isinstance(items, list):
                    items = [items]
                lines = [f"{'📁' if item['type'] == 'dir' else '📄'} {item['path']}" for item in items]
                reply = f"Files in `{repo}/{path or ''}`:\n\n" + "\n".join(lines)
                item_list = [{"type": item["type"], "path": item["path"], "name": item["name"]} for item in items]
                return {"reply": reply, "action": "list_files", "repo": repo, "items": item_list}
            else:
                return {"reply": f"❌ Files fetch nahi hue: {r.json().get('message','')}", "action": "error"}

        elif cmd == "READ_FILE":
            repo, path = params["repo"], params["path"]
            r = gh_api("GET", f"/repos/{owner}/{repo}/contents/{path}", gh_token)
            if r.status_code == 200:
                file_data = r.json()
                content = base64.b64decode(file_data["content"]).decode("utf-8", errors="replace")
                return {"reply": f"📄 `{path}` ({file_data['size']} bytes):\n\n```\n{content}\n```",
                        "action": "read_file", "content": content, "sha": file_data["sha"],
                        "repo": repo, "path": path}
            else:
                return {"reply": f"❌ File nahi mili: {r.json().get('message','')}", "action": "error"}

        elif cmd == "CREATE_FILE":
            repo, path, content = params["repo"], params["path"], params["content"]
            message = params.get("message", f"Add {path} via DevOps Agent")
            content_b64 = base64.b64encode(content.encode()).decode()
            existing_sha = get_file_sha(repo, path, owner, gh_token)
            payload = {"message": message, "content": content_b64}
            if existing_sha:
                payload["sha"] = existing_sha
            r = gh_api("PUT", f"/repos/{owner}/{repo}/contents/{path}", gh_token, json=payload)
            if r.status_code in (200, 201):
                url = r.json()["content"]["html_url"]
                action = "update_file" if existing_sha else "create_file"
                verb = "Update" if existing_sha else "Bana"
                return {"reply": f"✅ File {verb} di!\n**{path}**\n🔗 {url}", "action": action, "url": url, "repo": repo}
            else:
                return {"reply": f"❌ GitHub Error: {r.json().get('message','File nahi bani')}", "action": "error"}

        elif cmd == "EDIT_FILE":
            repo, path, content = params["repo"], params["path"], params["content"]
            message = params.get("message", f"Update {path} via DevOps Agent")
            sha = get_file_sha(repo, path, owner, gh_token)
            if not sha:
                return {"reply": f"❌ File `{path}` exist nahi karti repo `{repo}` me.", "action": "error"}
            content_b64 = base64.b64encode(content.encode()).decode()
            r = gh_api("PUT", f"/repos/{owner}/{repo}/contents/{path}", gh_token,
                       json={"message": message, "content": content_b64, "sha": sha})
            if r.status_code in (200, 201):
                url = r.json()["content"]["html_url"]
                return {"reply": f"✅ File update ho gayi!\n**{path}**\n🔗 {url}", "action": "update_file", "url": url, "repo": repo}
            else:
                return {"reply": f"❌ Update Error: {r.json().get('message','')}", "action": "error"}

        elif cmd == "DELETE_FILE":
            repo, path = params["repo"], params["path"]
            message = params.get("message", f"Delete {path} via DevOps Agent")
            sha = get_file_sha(repo, path, owner, gh_token)
            if not sha:
                return {"reply": f"❌ File `{path}` exist nahi karti.", "action": "error"}
            r = gh_api("DELETE", f"/repos/{owner}/{repo}/contents/{path}", gh_token,
                       json={"message": message, "sha": sha})
            if r.status_code == 200:
                return {"reply": f"🗑️ File `{path}` delete ho gayi.", "action": "delete_file"}
            else:
                return {"reply": f"❌ Delete Error: {r.json().get('message','')}", "action": "error"}

        elif cmd == "GET_REPO_INFO":
            repo = params["repo"]
            r = gh_api("GET", f"/repos/{owner}/{repo}", gh_token)
            if r.status_code == 200:
                d = r.json()
                reply = (f"📁 **{d['name']}**\n"
                         f"⭐ Stars: {d['stargazers_count']} | 🍴 Forks: {d['forks_count']} | "
                         f"👁️ Watchers: {d['watchers_count']}\n"
                         f"🔓 Visibility: `{d['visibility']}`\n"
                         f"🕓 Last updated: {d['updated_at']}\n"
                         f"🔗 {d['html_url']}")
                if d.get("description"):
                    reply += f"\n📝 {d['description']}"
                return {"reply": reply, "action": "repo_info"}
            else:
                return {"reply": f"❌ Repo info fetch nahi hui: {r.json().get('message','')}", "action": "error"}

        # ──────────────── VERCEL ────────────────
        # Every Vercel branch below checks vc_token first and returns a
        # friendly "connect Vercel" prompt if missing, rather than crashing
        # on a None token — Vercel connection is optional, GitHub login is not.
        elif cmd == "VERCEL_LIST_PROJECTS":
            if not vc_token:
                return {"reply": "🔒 Pehle Vercel connect karo — user menu me 'Connect Vercel' dabao.", "action": "vercel_auth_required"}
            r = vc_api("GET", "/v9/projects", vc_token)
            if r.status_code == 200:
                projects = r.json().get("projects", [])
                if not projects:
                    return {"reply": "Koi Vercel project nahi mila.", "action": "vercel_list", "projects": []}
                lines = []
                for p in projects:
                    live = f"https://{p['name']}.vercel.app"
                    lines.append(f"▲ **{p['name']}** — `{p.get('framework') or 'static'}`\n🔗 {live}")
                # readyState of the most recent deployment maps to the
                # frontend's status badge (Live/Building/Error/etc.) — same
                # VERCEL_TERMINAL_STATES vocabulary used by
                # vercel_poll_deployment, plus the in-progress states.
                def _vercel_status(p):
                    latest = p.get("latestDeployments") or []
                    return (latest[0].get("readyState") if latest else None) or "UNKNOWN"
                return {"reply": f"Tere {len(projects)} Vercel projects:\n\n" + "\n\n".join(lines),
                        "action": "vercel_list", "projects": [{
                            "name": p["name"], "id": p["id"],
                            "framework": p.get("framework"),
                            "url": f"https://{p['name']}.vercel.app",
                            "status": _vercel_status(p),
                        } for p in projects]}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Vercel token invalid ya expire ho gaya. Dubara connect karo.", "action": "vercel_auth_required"}
            else:
                return {"reply": f"❌ Vercel projects fetch nahi hue: {r.text[:200]}", "action": "error"}

        elif cmd == "VERCEL_IMPORT_REPO":
            if not vc_token:
                return {"reply": "🔒 Pehle Vercel connect karo — user menu me 'Connect Vercel' dabao.", "action": "vercel_auth_required"}
            repo = params["repo"]
            project_name = params.get("project_name") or repo
            payload = {
                "name": project_name,
                "gitRepository": {"type": "github", "repo": f"{owner}/{repo}"},
            }
            r = vc_api("POST", "/v11/projects", vc_token, json=payload)
            if r.status_code in (200, 201):
                proj = r.json()
                latest = proj.get("latestDeployments") or []
                dep_id = (latest[0].get("uid") or latest[0].get("id")) if latest else None
                reply = (f"✅ `{repo}` Vercel se connect ho gaya!\n**Project: {proj['name']}**\n"
                         f"Project ID: `{proj.get('id')}`\n\n")
                if dep_id:
                    reply += (f"⏳ Vercel ne automatically ek initial build queue kar diya hai (Deployment ID: `{dep_id}`).\n"
                              f"Status check karne ke liye bol: 'check deployment status {dep_id}'.")
                else:
                    reply += f"Build abhi queue nahi hua. Deploy trigger karne ke liye bol: 'deploy {proj['name']} to vercel'."
                return {"reply": reply, "action": "vercel_import", "project_name": proj["name"], "project_id": proj.get("id")}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Vercel token invalid ya expire ho gaya. Dubara connect karo.", "action": "vercel_auth_required"}
            else:
                err = r.json().get("error", {}).get("message", r.text[:200])
                return {"reply": f"❌ Vercel import Error: {err}", "action": "error"}

        elif cmd == "VERCEL_DEPLOY":
            if not vc_token:
                return {"reply": "🔒 Pehle Vercel connect karo — user menu me 'Connect Vercel' dabao.", "action": "vercel_auth_required"}
            project_name = params["project_name"]
            proj = vercel_find_project(project_name, vc_token)
            if not proj:
                return {"reply": f"❌ Vercel project `{project_name}` nahi mila. Pehle import kar.", "action": "error"}

            git_repo = proj.get("link", {})
            repo_id = git_repo.get("repoId")
            git_branch = git_repo.get("productionBranch", "main")
            if not repo_id:
                return {"reply": f"❌ Project `{project_name}` GitHub se linked nahi hai. Pehle import kar.", "action": "error"}

            payload = {
                "name": project_name,
                "target": "production",
                "gitSource": {"type": "github", "repoId": repo_id, "ref": git_branch},
                "projectSettings": {"framework": proj.get("framework")}
            }
            r = vc_api("POST", "/v13/deployments", vc_token, json=payload)
            if r.status_code not in (200, 201):
                if r.status_code in (401, 403):
                    return {"reply": "❌ Vercel token invalid ya expire ho gaya. Dubara connect karo.", "action": "vercel_auth_required"}
                err = r.json().get("error", {}).get("message", r.text[:200])
                return {"reply": f"❌ Vercel deploy trigger Error: {err}", "action": "error"}

            dep = r.json()
            dep_id = dep.get("id")
            if not dep_id:
                return {"reply": "❌ Vercel ne deployment ID nahi diya, kuch galat hua.", "action": "error"}

            result = vercel_poll_deployment(dep_id, vc_token)
            if result["ok"]:
                return {"reply": f"✅ Deployment complete!\n**{project_name}**\n🔗 {result['live_url']}\n\nID: `{dep_id}`",
                        "action": "vercel_deploy", "deployment_id": dep_id, "url": result["live_url"], "project_name": project_name}
            elif result["timed_out"]:
                return {"reply": (f"⏳ Deploy trigger ho gaya hai (ID: `{dep_id}`), lekin build abhi bhi chal raha hai.\n\n"
                                   f"Status check karne ke liye thodi der baad bol: 'check deployment status {dep_id}'."),
                        "action": "vercel_deploy_pending", "deployment_id": dep_id, "project_name": project_name}
            else:
                error_detail = result["deployment"].get("errorMessage", "") or result["state"]
                return {"reply": f"❌ Deployment fail ho gaya.\nStatus: **{result['state']}**\n{error_detail}\nID: `{dep_id}`",
                        "action": "error", "deployment_id": dep_id}

        elif cmd == "VERCEL_DELETE_PROJECT":
            if not vc_token:
                return {"reply": "🔒 Pehle Vercel connect karo — user menu me 'Connect Vercel' dabao.", "action": "vercel_auth_required"}
            project_name = params["project_name"]
            proj = vercel_find_project(project_name, vc_token)
            if not proj:
                return {"reply": f"❌ Vercel project `{project_name}` nahi mila.", "action": "error"}
            r = vc_api("DELETE", f"/v9/projects/{proj.get('id')}", vc_token)
            if r.status_code in (200, 204):
                return {"reply": f"✅ Vercel project `{project_name}` delete ho gaya.\n\n⚠️ GitHub repo abhi bhi waisa hi hai.",
                        "action": "vercel_delete_project", "project_name": project_name}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Vercel token invalid ya expire ho gaya. Dubara connect karo.", "action": "vercel_auth_required"}
            else:
                err = r.json().get("error", {}).get("message", r.text[:200]) if r.text else r.text[:200]
                return {"reply": f"❌ Vercel project delete Error: {err}", "action": "error"}

        elif cmd == "VERCEL_GET_ENV":
            if not vc_token:
                return {"reply": "🔒 Pehle Vercel connect karo — user menu me 'Connect Vercel' dabao.", "action": "vercel_auth_required"}
            project_name = params["project_name"]
            proj = vercel_find_project(project_name, vc_token)
            if not proj:
                return {"reply": f"❌ Vercel project `{project_name}` nahi mila.", "action": "error"}
            r = vc_api("GET", f"/v9/projects/{proj.get('id')}/env", vc_token)
            if r.status_code == 200:
                envs = r.json().get("envs", [])
                if not envs:
                    return {"reply": f"Project `{project_name}` me koi env vars nahi hai.", "action": "vercel_env"}
                lines = [f"`{e['key']}` — targets: {', '.join(e.get('target', []))}" for e in envs]
                return {"reply": f"Env vars for `{project_name}` (values encrypted, sirf keys dikha sakta hu):\n\n" + "\n".join(lines),
                        "action": "vercel_env"}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Vercel token invalid ya expire ho gaya. Dubara connect karo.", "action": "vercel_auth_required"}
            else:
                return {"reply": f"❌ Env vars fetch nahi hue: {r.text[:200]}", "action": "error"}

        elif cmd == "VERCEL_SET_ENV":
            if not vc_token:
                return {"reply": "🔒 Pehle Vercel connect karo — user menu me 'Connect Vercel' dabao.", "action": "vercel_auth_required"}
            project_name = params["project_name"]
            key = params["key"]
            value = params["value"]
            target = params.get("target", ["production", "preview", "development"])
            proj = vercel_find_project(project_name, vc_token)
            if not proj:
                return {"reply": f"❌ Vercel project `{project_name}` nahi mila.", "action": "error"}
            r = vc_api("POST", f"/v10/projects/{proj.get('id')}/env", vc_token,
                       json={"key": key, "value": value, "type": "encrypted", "target": target})
            if r.status_code in (200, 201):
                return {"reply": f"✅ Env var `{key}` set ho gaya `{project_name}` me.\n⚠️ Naya deploy trigger karo change apply karne ke liye.",
                        "action": "vercel_env_set"}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Vercel token invalid ya expire ho gaya. Dubara connect karo.", "action": "vercel_auth_required"}
            else:
                err = r.json().get("error", {}).get("message", r.text[:200])
                return {"reply": f"❌ Env set Error: {err}", "action": "error"}

        # ──────────────── NETLIFY ────────────────
        elif cmd == "NETLIFY_LIST_SITES":
            if not nl_token:
                return {"reply": "🔒 Pehle Netlify connect karo — user menu me 'Connect Netlify' dabao.", "action": "netlify_auth_required"}
            r = nl_api("GET", "/sites?per_page=50", nl_token)
            if r.status_code == 200:
                sites = r.json()
                if not sites:
                    return {"reply": "Koi Netlify site nahi mili.", "action": "netlify_list", "sites": []}
                lines = [f"🌐 **{s['name']}**\n🔗 {s.get('url', '')}" for s in sites]
                return {"reply": f"Teri {len(sites)} Netlify sites:\n\n" + "\n\n".join(lines),
                        "action": "netlify_list", "sites": [{
                            "name": s["name"], "id": s["id"], "url": s.get("url", ""),
                            "status": s.get("state", "unknown"),
                        } for s in sites]}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Netlify token invalid ya expire ho gaya. Dubara connect karo.", "action": "netlify_auth_required"}
            else:
                return {"reply": f"❌ Netlify sites fetch nahi hui: {r.text[:200]}", "action": "error"}

        elif cmd == "NETLIFY_GET_SITE_INFO":
            if not nl_token:
                return {"reply": "🔒 Pehle Netlify connect karo — user menu me 'Connect Netlify' dabao.", "action": "netlify_auth_required"}
            site_name = params["site_name"]
            site = netlify_find_site(site_name, nl_token)
            if not site:
                return {"reply": f"❌ Netlify site `{site_name}` nahi mili.", "action": "error"}
            reply = (f"🌐 **{site['name']}**\n"
                     f"🔗 {site.get('url', '')}\n"
                     f"🆔 `{site['id']}`\n"
                     f"🕓 Last updated: {site.get('updated_at', '')}")
            if site.get("custom_domain"):
                reply += f"\n🌍 Custom domain: {site['custom_domain']}"
            return {"reply": reply, "action": "netlify_site_info"}

        elif cmd == "NETLIFY_DELETE_SITE":
            if not nl_token:
                return {"reply": "🔒 Pehle Netlify connect karo — user menu me 'Connect Netlify' dabao.", "action": "netlify_auth_required"}
            site_name = params["site_name"]
            site = netlify_find_site(site_name, nl_token)
            if not site:
                return {"reply": f"❌ Netlify site `{site_name}` nahi mili.", "action": "error"}
            r = nl_api("DELETE", f"/sites/{site['id']}", nl_token)
            if r.status_code in (200, 204):
                return {"reply": f"🗑️ Netlify site `{site_name}` delete ho gayi.", "action": "netlify_delete_site"}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Netlify token invalid ya expire ho gaya. Dubara connect karo.", "action": "netlify_auth_required"}
            else:
                return {"reply": f"❌ Site delete Error: {r.text[:200]}", "action": "error"}

        elif cmd == "NETLIFY_GET_ENV":
            if not nl_token:
                return {"reply": "🔒 Pehle Netlify connect karo — user menu me 'Connect Netlify' dabao.", "action": "netlify_auth_required"}
            site_name = params["site_name"]
            site = netlify_find_site(site_name, nl_token)
            if not site:
                return {"reply": f"❌ Netlify site `{site_name}` nahi mili.", "action": "error"}
            account_id = site.get("account_id")
            if not account_id:
                return {"reply": "❌ Is site ka account_id nahi mila.", "action": "error"}
            r = nl_api("GET", f"/accounts/{account_id}/env?site_id={site['id']}", nl_token)
            if r.status_code == 200:
                envs = r.json()
                if not envs:
                    return {"reply": f"Site `{site_name}` me koi env vars nahi hai.", "action": "netlify_env"}
                lines = [f"`{e['key']}`" for e in envs]
                return {"reply": f"Env vars for `{site_name}` (values encrypted, sirf keys dikha sakta hu):\n\n" + "\n".join(lines),
                        "action": "netlify_env"}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Netlify token invalid ya expire ho gaya. Dubara connect karo.", "action": "netlify_auth_required"}
            else:
                return {"reply": f"❌ Env vars fetch nahi hue: {r.text[:200]}", "action": "error"}

        elif cmd == "NETLIFY_SET_ENV":
            if not nl_token:
                return {"reply": "🔒 Pehle Netlify connect karo — user menu me 'Connect Netlify' dabao.", "action": "netlify_auth_required"}
            site_name = params["site_name"]
            key = params["key"]
            value = params["value"]
            site = netlify_find_site(site_name, nl_token)
            if not site:
                return {"reply": f"❌ Netlify site `{site_name}` nahi mili.", "action": "error"}
            account_id = site.get("account_id")
            if not account_id:
                return {"reply": "❌ Is site ka account_id nahi mila.", "action": "error"}
            payload = {
                "key": key,
                "scopes": ["builds", "functions", "runtime", "post_processing"],
                "values": [{"value": value, "context": "all"}],
            }
            r = nl_api("POST", f"/accounts/{account_id}/env?site_id={site['id']}", nl_token, json=payload)
            if r.status_code in (200, 201):
                return {"reply": f"✅ Env var `{key}` set ho gaya `{site_name}` me.\n⚠️ Naya deploy trigger karo change apply karne ke liye.",
                        "action": "netlify_env_set"}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Netlify token invalid ya expire ho gaya. Dubara connect karo.", "action": "netlify_auth_required"}
            else:
                return {"reply": f"❌ Env set Error: {r.text[:200]}", "action": "error"}

        # ──────────────── RENDER ────────────────
        elif cmd == "RENDER_LIST_SERVICES":
            if not rd_token:
                return {"reply": "🔒 Pehle Render connect karo — user menu me 'Connect Render' dabao.", "action": "render_auth_required"}
            r = rd_api("GET", "/services?limit=50", rd_token)
            if r.status_code == 200:
                items = r.json()
                if not items:
                    return {"reply": "Koi Render service nahi mila.", "action": "render_list", "services": []}
                lines = []
                services = []
                for item in items:
                    svc = item.get("service", item)
                    name = svc.get("name", "unknown")
                    stype = svc.get("type", "service")
                    sid = svc.get("id", "")
                    url = svc.get("serviceDetails", {}).get("url", "")
                    # Render's REST API doesn't return a simple ready/building
                    # enum on the service object itself (that lives on
                    # individual deploys) — "suspended" is the one reliable
                    # top-level signal available here without an extra call
                    # per service. The frontend treats missing/unknown status
                    # as neutral rather than assuming healthy.
                    suspended = svc.get("suspended") == "suspended"
                    icon = {"web_service": "🌐", "static_site": "📦", "private_service": "🔒",
                            "background_worker": "⚙️", "cron_job": "⏰", "postgres": "🐘", "redis": "🟥"}.get(stype, "🧩")
                    line = f"{icon} **{name}** — `{stype}`\nID: `{sid}`"
                    if url:
                        line += f"\n🔗 {url}"
                    lines.append(line)
                    services.append({
                        "name": name, "id": sid, "type": stype, "url": url,
                        "status": "suspended" if suspended else "active",
                    })
                return {"reply": f"Tere {len(items)} Render services:\n\n" + "\n\n".join(lines),
                        "action": "render_list", "services": services}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Render token invalid ya expire ho gaya. Dubara connect karo.", "action": "render_auth_required"}
            else:
                return {"reply": f"❌ Render services fetch nahi hue: {r.text[:200]}", "action": "error"}

        elif cmd == "RENDER_GET_ENV":
            if not rd_token:
                return {"reply": "🔒 Pehle Render connect karo — user menu me 'Connect Render' dabao.", "action": "render_auth_required"}
            service_id = params["service_id"]
            r = rd_api("GET", f"/services/{service_id}/env-vars?limit=100", rd_token)
            if r.status_code == 200:
                items = r.json()
                if not items:
                    return {"reply": f"Service `{service_id}` me koi env vars nahi hai.", "action": "render_env"}
                lines = [f"`{item['envVar']['key']}` = `{item['envVar']['value']}`" for item in items]
                return {"reply": f"Env vars for `{service_id}`:\n\n" + "\n".join(lines), "action": "render_env"}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Render token invalid ya expire ho gaya. Dubara connect karo.", "action": "render_auth_required"}
            else:
                return {"reply": f"❌ Env vars fetch nahi hue: {r.text[:200]}", "action": "error"}

        elif cmd == "RENDER_SET_ENV":
            if not rd_token:
                return {"reply": "🔒 Pehle Render connect karo — user menu me 'Connect Render' dabao.", "action": "render_auth_required"}
            service_id = params["service_id"]
            new_vars = params["env_vars"]

            existing_r = rd_api("GET", f"/services/{service_id}/env-vars?limit=100", rd_token)
            existing = {}
            if existing_r.status_code == 200:
                for item in existing_r.json():
                    existing[item["envVar"]["key"]] = item["envVar"]["value"]
            elif existing_r.status_code in (401, 403):
                return {"reply": "❌ Render token invalid ya expire ho gaya. Dubara connect karo.", "action": "render_auth_required"}

            existing.update(new_vars)
            payload = [{"key": k, "value": v} for k, v in existing.items()]

            r = rd_api("PUT", f"/services/{service_id}/env-vars", rd_token, json=payload)
            if r.status_code in (200, 201):
                keys = ", ".join(new_vars.keys())
                return {"reply": f"✅ Env vars update ho gaye for `{service_id}`!\nUpdated keys: `{keys}`\n\n⚠️ Service redeploy hoga automatically Render ki taraf se.",
                        "action": "render_env_update"}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Render token invalid ya expire ho gaya. Dubara connect karo.", "action": "render_auth_required"}
            else:
                return {"reply": f"❌ Env update Error: {r.text[:200]}", "action": "error"}

        elif cmd == "RENDER_DEPLOY":
            if not rd_token:
                return {"reply": "🔒 Pehle Render connect karo — user menu me 'Connect Render' dabao.", "action": "render_auth_required"}
            service_id = params["service_id"]
            clear_cache = params.get("clear_cache", False)
            payload = {"clearCache": "clear" if clear_cache else "do_not_clear"}
            r = rd_api("POST", f"/services/{service_id}/deploys", rd_token, json=payload)
            if r.status_code in (200, 201):
                dep = r.json()
                dep_id = dep.get("id", "")
                status = dep.get("status", "queued")
                cache_note = "(cache cleared)" if clear_cache else ""
                return {"reply": f"🚀 Deploy trigger ho gaya for `{service_id}` {cache_note}\nDeploy ID: `{dep_id}`\nStatus: **{status}**",
                        "action": "render_deploy", "deploy_id": dep_id, "status": status}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Render token invalid ya expire ho gaya. Dubara connect karo.", "action": "render_auth_required"}
            else:
                return {"reply": f"❌ Render deploy Error: {r.text[:200]}", "action": "error"}

        elif cmd == "RENDER_DELETE_SERVICE":
            if not rd_token:
                return {"reply": "🔒 Pehle Render connect karo — user menu me 'Connect Render' dabao.", "action": "render_auth_required"}
            service_id = params["service_id"]
            r = rd_api("DELETE", f"/services/{service_id}", rd_token)
            if r.status_code in (200, 204):
                return {"reply": f"🗑️ Render service `{service_id}` delete ho gaya.", "action": "render_delete_service"}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Render token invalid ya expire ho gaya. Dubara connect karo.", "action": "render_auth_required"}
            else:
                return {"reply": f"❌ Service delete Error: {r.text[:200]}", "action": "error"}

        else:
            return {"reply": f"❌ Unknown command: {cmd}", "action": "error"}

    except KeyError as e:
        return {"reply": f"❌ Required field missing: {str(e)}. Dobara try kar zyada detail ke saath.", "action": "error"}
    except requests.Timeout:
        return {"reply": "❌ Request timeout ho gaya. Dobara try karo 🔄", "action": "error"}
    except Exception as e:
        return {"reply": f"❌ Error: {str(e)}", "action": "error"}


# ════════════════════════════════════════════════════════════════
#  INTENT PARSER (same regex approach as the single-user version,
#  trimmed to the commands wired up in this first pass)
# ════════════════════════════════════════════════════════════════
SLUG = r"[\w][\w.\-]*"
PATH = r"[\w][\w./\-]*"

NO_ARG_COMMANDS = {"LIST_REPOS", "VERCEL_LIST_PROJECTS", "NETLIFY_LIST_SITES", "RENDER_LIST_SERVICES"}


def _g(m, i):
    try:
        return m.group(i)
    except (IndexError, AttributeError):
        return None


INTENT_RULES = [
    ("LIST_FILES", [
        rf"(?:list|sare|show|dikhao|dikha)\s+(?:all\s+)?files?\s+(?:in|of|from)\s+({SLUG})",
    ], lambda m: {"repo": _g(m, 1), "path": ""}),

    ("READ_FILE", [
        rf"(?:read|padh|padho|show|dikhao|dikha|open|kholo)\s+(?:the\s+)?file\s+({PATH})\s+(?:from|in|of)\s+({SLUG})",
    ], lambda m: {"repo": _g(m, 2), "path": _g(m, 1)}),

    ("DELETE_FILE", [
        rf"(?:delete|uda|udado|hata|hatao|remove)\s+(?:the\s+)?file\s+({PATH})\s+(?:from|in|of)\s+({SLUG})",
    ], lambda m: {"repo": _g(m, 2), "path": _g(m, 1)}),

    ("EDIT_FILE", [
        rf"(?:edit|change|update|badlo|badal\s*do|modify)\s+(?:the\s+)?file\s+({PATH})\s+(?:in|of)\s+({SLUG})",
    ], lambda m: {"repo": _g(m, 2), "path": _g(m, 1)}),

    ("CREATE_FILE", [
        rf"(?:create|bnao|banao|new|naya)\s+(?:a\s+)?file\s+({PATH})\s+(?:in|inside|for)\s+({SLUG})",
    ], lambda m: {"repo": _g(m, 2), "path": _g(m, 1)}),

    ("CREATE_REPO", [
        rf"(?:create|bnao|banao|naya|new)\s+(?:a\s+|ek\s+)?repo(?:sitory)?\s+"
        rf"(?:called\s+|named\s+)?(?:bnao|banao|bana\s*do)\s+({SLUG})",
        rf"(?:create|bnao|banao|naya|new)\s+(?:a\s+|ek\s+)?repo(?:sitory)?\s+(?:called\s+|named\s+)?({SLUG})",
        rf"repo(?:sitory)?\s+({SLUG})\s+(?:create|bnao|banao|bana(?:\s*do)?)\s*(?:karo|kar\s*do)?$",
    ], lambda m: {"repo": _g(m, 1)}),

    ("DELETE_REPO", [
        rf"(?:delete|uda|udado|hata|hatao|remove)\s+(?:the\s+)?repo(?:sitory)?\s+({SLUG})",
        rf"repo(?:sitory)?\s+({SLUG})\s+(?:delete|uda(?:\s*do)?|hata(?:o|\s*do)?|remove)\s*(?:karo|kar\s*do)?$",
    ], lambda m: {"repo": _g(m, 1)}),

    ("GET_REPO_INFO", [
        rf"(?:info|information|details)\s+(?:about|of|for)\s+(?:repo\s+)?({SLUG})",
        rf"repo\s+info\s+({SLUG})",
        rf"({SLUG})\s+ki\s+info\s+(?:do|dikhao|dikha)",
    ], lambda m: {"repo": _g(m, 1)}),

    ("LIST_REPOS", [
        r"(?:list|sare|mere|show|dikhao|dikha)\s+.*\brepos?\b",
        r"^(?:repos?|my\s+repos?)$",
    ], lambda m: {}),

    # ── VERCEL ──
    ("VERCEL_LIST_PROJECTS", [
        r"(?:list|sare|show|dikhao|dikha)\s+.*vercel.*projects?\b",
        r"^vercel\s+projects?$",
    ], lambda m: {}),

    ("VERCEL_IMPORT_REPO", [
        rf"(?:import|connect)\s+({SLUG})\s+(?:to|pe|on|with)\s+vercel",
    ], lambda m: {"repo": _g(m, 1)}),

    ("VERCEL_DEPLOY", [
        rf"deploy\s+({SLUG})\s+(?:to|pe|on)\s+vercel",
    ], lambda m: {"project_name": _g(m, 1)}),

    ("VERCEL_DELETE_PROJECT", [
        rf"(?:delete|uda|hata)\s+vercel\s+project\s+({SLUG})",
    ], lambda m: {"project_name": _g(m, 1)}),

    ("VERCEL_GET_ENV", [
        rf"(?:get|show|dikhao|dikha)\s+.*env(?:ironment)?(?:\s+vars?)?\s+(?:for|of)\s+({SLUG})\s+.*vercel",
        rf"vercel\s+.*env(?:ironment)?(?:\s+vars?)?\s+(?:for|of)\s+({SLUG})",
    ], lambda m: {"project_name": _g(m, 1)}),

    ("VERCEL_SET_ENV", [
        rf"(?:set|add|update)\s+env\s+(\w+)\s*=\s*(\S+)\s+(?:for|in|on)\s+({SLUG})\s+.*vercel",
        rf"(?:set|add|update)\s+vercel\s+env\s+(\w+)\s*=\s*(\S+)\s+(?:for|in|on)\s+({SLUG})",
    ], lambda m: {"project_name": _g(m, 3), "key": _g(m, 1), "value": _g(m, 2)}),

    # ── NETLIFY ──
    ("NETLIFY_LIST_SITES", [
        r"(?:list|sare|show|dikhao|dikha)\s+.*netlify.*sites?\b",
        r"^netlify\s+sites?$",
    ], lambda m: {}),

    ("NETLIFY_DELETE_SITE", [
        rf"(?:delete|uda|hata)\s+netlify\s+site\s+({SLUG})",
    ], lambda m: {"site_name": _g(m, 1)}),

    ("NETLIFY_GET_SITE_INFO", [
        rf"(?:info|information|details)\s+(?:about|of|for)\s+netlify\s+site\s+({SLUG})",
        rf"netlify\s+site\s+info\s+({SLUG})",
    ], lambda m: {"site_name": _g(m, 1)}),

    ("NETLIFY_GET_ENV", [
        rf"(?:get|show|dikhao|dikha)\s+.*env(?:ironment)?(?:\s+vars?)?\s+(?:for|of)\s+({SLUG})\s+.*netlify",
        rf"netlify\s+.*env(?:ironment)?(?:\s+vars?)?\s+(?:for|of)\s+({SLUG})",
    ], lambda m: {"site_name": _g(m, 1)}),

    ("NETLIFY_SET_ENV", [
        rf"(?:set|add|update)\s+env\s+(\w+)\s*=\s*(\S+)\s+(?:for|in|on)\s+({SLUG})\s+.*netlify",
        rf"(?:set|add|update)\s+netlify\s+env\s+(\w+)\s*=\s*(\S+)\s+(?:for|in|on)\s+({SLUG})",
    ], lambda m: {"site_name": _g(m, 3), "key": _g(m, 1), "value": _g(m, 2)}),

    # ── RENDER ──
    ("RENDER_LIST_SERVICES", [
        r"(?:list|sare|show|dikhao|dikha)\s+.*render.*services?\b",
        r"(?:list|sare|show|dikhao|dikha)\s+.*services?.*render\b",
        r"^render\s+services?$",
        r"^services?\s+render$",
        r"^render\s+(?:ke\s+)?services?\s+(?:dikhao|dikha|show|list)$",
    ], lambda m: {}),

    ("RENDER_DELETE_SERVICE", [
        rf"(?:delete|uda|udado|hata|hatao|remove)\s+(?:the\s+)?(?:render\s+)?service\s+({SLUG})",
    ], lambda m: {"service_id": _g(m, 1)}),

    ("RENDER_DELETE_SERVICE", [
        rf"({SLUG})\s+service\s+(?:delete|uda(?:o|\s*do)?|hata(?:o|\s*do)?)\s*(?:karo|kar\s*do)?",
    ], lambda m: {"service_id": _g(m, 1)}),

    ("RENDER_GET_ENV", [
        rf"(?:get|show|dikhao|dikha)\s+.*env(?:ironment)?(?:\s+vars?)?\s+(?:for|of)\s+({SLUG})\s+.*render",
        rf"render\s+.*env(?:ironment)?(?:\s+vars?)?\s+(?:for|of)\s+({SLUG})",
    ], lambda m: {"service_id": _g(m, 1)}),

    ("RENDER_SET_ENV", [
        rf"(?:set|add|update)\s+env\s+(\w+)\s*=\s*(\S+)\s+(?:for|in|on)\s+({SLUG})\s+.*render",
        rf"(?:set|add|update)\s+render\s+env\s+(\w+)\s*=\s*(\S+)\s+(?:for|in|on)\s+({SLUG})",
    ], lambda m: {"service_id": _g(m, 3), "env_vars": {_g(m, 1): _g(m, 2)}}),

    ("RENDER_DEPLOY", [
        rf"deploy\s+({SLUG})\s+(?:to|pe|on)\s+render",
    ], lambda m: {"service_id": _g(m, 1)}),
]

COMPLEX_KEYWORDS = [
    "likh", "likho", "banao", "banado", "bnado", "code", "html", "css", "js",
    "javascript", "script", "function", "explain", "samjha", "samjhao",
    "kaise", "kyu", "kyun", "kya", "write", "generate", "design", "navbar",
    "component", "snippet", "fix kar", "debug",
]


def parse_intent(message):
    original = message.strip()
    lowered = original.lower()

    # Several Vercel/Render/Netlify patterns are intentionally loose (no
    # platform keyword required, e.g. "get env vars for X") so short,
    # natural phrasing still matches. But that means a message that
    # explicitly names a DIFFERENT platform ("... for X netlify") could get
    # swallowed by a generic Vercel/Render pattern that runs earlier in the
    # list, before ever reaching the correctly-specific Netlify rule below
    # it. Guard against that directly: if the message names a specific
    # platform, skip every rule belonging to a different one.
    mentioned = {p for p in ("vercel", "render", "netlify") if re.search(rf"\b{p}\b", lowered)}

    def rule_platform(cmd):
        if cmd.startswith("VERCEL_"): return "vercel"
        if cmd.startswith("RENDER_"): return "render"
        if cmd.startswith("NETLIFY_"): return "netlify"
        return None

    for cmd, patterns, extractor in INTENT_RULES:
        rp = rule_platform(cmd)
        if rp and mentioned and rp not in mentioned:
            continue
        for pat in patterns:
            m = re.search(pat, lowered)
            if m:
                try:
                    params = extractor(m)
                except Exception:
                    continue
                required_fields = {"repo", "project_name", "site_name", "service_id", "key"}
                if any(params.get(f) in (None, "") for f in required_fields if f in params):
                    continue
                # VERCEL_SET_ENV / NETLIFY_SET_ENV: env var keys are
                # conventionally uppercase and case-sensitive. The match
                # above ran against the lowercased message, so recover the
                # original casing for the key by re-matching the same span
                # against the original (non-lowered) message.
                if cmd in ("VERCEL_SET_ENV", "NETLIFY_SET_ENV"):
                    orig_m = re.search(pat, original, re.IGNORECASE)
                    if orig_m:
                        params["key"] = orig_m.group(1)
                # RENDER_SET_ENV keeps its key inside env_vars (a dict),
                # not a flat "key" field — same casing-recovery need, just
                # applied to the dict's single entry.
                if cmd == "RENDER_SET_ENV":
                    orig_m = re.search(pat, original, re.IGNORECASE)
                    if orig_m and params.get("env_vars"):
                        real_key = orig_m.group(1)
                        params["env_vars"] = {real_key: list(params["env_vars"].values())[0]}
                return cmd, params
    return None, None


# ════════════════════════════════════════════════════════════════
#  AI FALLBACK — same idea as single-user version: only reached when
#  regex finds nothing. Uses YOUR OpenRouter key (app-level, shared
#  infra) purely for language understanding / codegen — it never
#  gets anyone's GitHub token, and its own output still only reaches
#  GitHub through execute_command() with the calling user's token.
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
{vercel_commands}{netlify_commands}{render_commands}
RULES:
- Output ONLY the command, nothing else, UNLESS the request is conversational/explanatory.
- JSON must be valid. Escape quotes as \\" and newlines as \\n in content fields.
- NEVER invent URLs, IDs, or data you don't have — only the commands above give you real information.
- NEVER output anything resembling a real token/secret, even as an example.
{vercel_note}{netlify_note}{render_note}"""

VERCEL_COMMANDS_BLOCK = """10. VERCEL_LIST_PROJECTS
11. VERCEL_IMPORT_REPO: {"repo":"repo-name","project_name":"optional-custom-name"}
12. VERCEL_DEPLOY: {"project_name":"project-name"}
13. VERCEL_DELETE_PROJECT: {"project_name":"project-name"}
14. VERCEL_GET_ENV: {"project_name":"project-name"}
15. VERCEL_SET_ENV: {"project_name":"project-name","key":"KEY","value":"value"}
"""

NETLIFY_COMMANDS_BLOCK = """16. NETLIFY_LIST_SITES
17. NETLIFY_GET_SITE_INFO: {"site_name":"site-name"}
18. NETLIFY_DELETE_SITE: {"site_name":"site-name"}
19. NETLIFY_GET_ENV: {"site_name":"site-name"}
20. NETLIFY_SET_ENV: {"site_name":"site-name","key":"KEY","value":"value"}
"""

RENDER_COMMANDS_BLOCK = """21. RENDER_LIST_SERVICES
22. RENDER_DELETE_SERVICE: {"service_id":"srv-xxx"}
23. RENDER_GET_ENV: {"service_id":"srv-xxx"}
24. RENDER_SET_ENV: {"service_id":"srv-xxx","env_vars":{"KEY":"value"}}
25. RENDER_DEPLOY: {"service_id":"srv-xxx","clear_cache":false}
"""

CODEGEN_SYSTEM_PROMPT = """You generate file content for a developer tool. Output ONLY the raw file content — no markdown fences, no explanation. Write complete, working code. Infer language from the file path."""

COMMANDS = [
    "CREATE_REPO:", "DELETE_REPO:", "LIST_REPOS", "CREATE_FILE:",
    "READ_FILE:", "EDIT_FILE:", "DELETE_FILE:", "LIST_FILES:", "GET_REPO_INFO:",
    "VERCEL_LIST_PROJECTS", "VERCEL_IMPORT_REPO:", "VERCEL_DEPLOY:",
    "VERCEL_DELETE_PROJECT:", "VERCEL_GET_ENV:", "VERCEL_SET_ENV:",
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


# ════════════════════════════════════════════════════════════════
#  ROUTES
# ════════════════════════════════════════════════════════════════
@app.route("/")
def home():
    return send_from_directory(".", "index.html")


# ════════════════════════════════════════════════════════════════
#  STATIC SEO / FAVICON FILES
#  Served explicitly (rather than relying on a generic static folder)
#  since this Flask app has no separate /static route configured —
#  everything is served from the project root via send_from_directory.
#  Correct mimetypes matter here: browsers and crawlers can be picky
#  about robots.txt/sitemap.xml not being served as text/plain or
#  application/xml respectively.
# ════════════════════════════════════════════════════════════════
@app.route("/favicon.ico")
def favicon_ico():
    return send_from_directory(".", "favicon.ico", mimetype="image/vnd.microsoft.icon")


@app.route("/favicon-16x16.png")
def favicon_16():
    return send_from_directory(".", "favicon-16x16.png", mimetype="image/png")


@app.route("/favicon-32x32.png")
def favicon_32():
    return send_from_directory(".", "favicon-32x32.png", mimetype="image/png")


@app.route("/favicon-48x48.png")
def favicon_48():
    return send_from_directory(".", "favicon-48x48.png", mimetype="image/png")


@app.route("/apple-touch-icon.png")
def apple_touch_icon():
    return send_from_directory(".", "apple-touch-icon.png", mimetype="image/png")


@app.route("/android-chrome-192x192.png")
def android_chrome_192():
    return send_from_directory(".", "android-chrome-192x192.png", mimetype="image/png")


@app.route("/android-chrome-512x512.png")
def android_chrome_512():
    return send_from_directory(".", "android-chrome-512x512.png", mimetype="image/png")


@app.route("/site.webmanifest")
def site_webmanifest():
    return send_from_directory(".", "site.webmanifest", mimetype="application/manifest+json")


@app.route("/robots.txt")
def robots_txt():
    return send_from_directory(".", "robots.txt", mimetype="text/plain")


@app.route("/sitemap.xml")
def sitemap_xml():
    return send_from_directory(".", "sitemap.xml", mimetype="application/xml")


@app.route("/api/repos", methods=["GET"])
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


@app.route("/api/repo-folders", methods=["GET"])
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


@app.route("/api/repo-files", methods=["GET"])
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


@app.route("/api/vercel/deploy-events", methods=["GET"])
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


@app.route("/chat", methods=["POST"])
def chat():
    user = current_user()
    if not user:
        return safe_jsonify({
            "reply": "🔒 Pehle GitHub se connect karo — chat ke upar 'Connect GitHub' button dabao.",
            "action": "auth_required", "source": "direct"
        }), 401

    gh_token = decrypt_token(user["github_token_encrypted"])
    if not gh_token:
        # Encrypted token failed to decrypt (e.g. FERNET_KEY rotated) — force re-login
        # rather than silently failing every subsequent call.
        delete_user(user["id"])
        resp = safe_jsonify({
            "reply": "🔒 Session expire ho gayi, dubara connect karo.",
            "action": "auth_required", "source": "direct"
        })
        resp = make_response(resp, 401)
        clear_session_cookie(resp)
        return resp

    owner = user["github_login"]
    vc_token = get_user_vercel_token(user)
    nl_token = get_user_netlify_token(user)
    rd_token = get_user_render_token(user)
    body = request.json or {}

    # 1. CONFIRMED DESTRUCTIVE ACTION REPLAY
    if body.get("confirmed"):
        cmd = body.get("pending_command")
        value = body.get("pending_value")
        token = body.get("confirm_token")
        if cmd not in DESTRUCTIVE_COMMANDS or token != confirm_token(cmd, value, user["id"]):
            return safe_jsonify({"reply": "❌ Confirmation token match nahi hua. Dobara try kar.", "action": "error", "source": "direct"})
        try:
            params = json.loads(value) if value else {}
        except (json.JSONDecodeError, TypeError):
            params = {}
        result = execute_command(cmd, params, owner, gh_token, vc_token, nl_token, rd_token)
        result["source"] = "direct"
        return safe_jsonify(result)

    user_message = body.get("message", "").strip()
    conv_history = body.get("history", [])

    if not user_message:
        return safe_jsonify({"reply": "Kuch toh bol bhai 😅", "action": None, "source": "direct"})

    # 2. STRUCTURAL INTENT MATCH
    cmd, params = parse_intent(user_message)

    if cmd:
        if cmd in ("CREATE_FILE", "EDIT_FILE"):
            try:
                result = handle_create_or_edit_file(cmd, params, user_message, owner, gh_token)
                return safe_jsonify(result)
            except RuntimeError as e:
                return safe_jsonify({"reply": f"❌ AI Error: {str(e)}", "action": "error", "source": "hybrid"})
            except requests.Timeout:
                return safe_jsonify({"reply": "AI ne content generate karne me bahut time lagaya. Dobara try karo 🔄", "action": "error", "source": "hybrid"})
            except Exception as e:
                return safe_jsonify({"reply": f"❌ Error: {str(e)}", "action": "error", "source": "hybrid"})

        if cmd in DESTRUCTIVE_COMMANDS:
            return safe_jsonify(build_confirmation(cmd, params, user["id"]))

        result = execute_command(cmd, params, owner, gh_token, vc_token, nl_token, rd_token)
        result["source"] = "direct"
        result["action_command"] = cmd
        return safe_jsonify(result)

    # 3. AI FALLBACK
    try:
        ai_text = call_openrouter_chat(user_message, conv_history, owner, vercel_connected=bool(vc_token), netlify_connected=bool(nl_token), render_connected=bool(rd_token))
    except RuntimeError as e:
        return safe_jsonify({"reply": f"AI Error: {str(e)}", "action": "error", "source": "ai"})
    except requests.Timeout:
        return safe_jsonify({"reply": "AI ne jawab dene me bahut time lagaya. Dobara try karo 🔄", "action": "error", "source": "ai"})
    except Exception as e:
        return safe_jsonify({"reply": f"AI connection error: {str(e)}", "action": "error", "source": "ai"})

    ai_cmd, ai_value = extract_command(ai_text)

    if ai_cmd:
        if ai_cmd in NO_ARG_COMMANDS:
            ai_params = {}
        else:
            try:
                if ai_value and ai_value.strip().startswith("{"):
                    ai_params = json.loads(ai_value)
                elif ai_cmd in ("CREATE_REPO", "DELETE_REPO"):
                    ai_params = {"repo": (ai_value or "").strip()}
                else:
                    ai_params = {}
            except json.JSONDecodeError:
                return safe_jsonify({"reply": "❌ AI ne sahi JSON nahi diya. Dobara try karo.", "action": "error", "source": "ai"})

        if ai_cmd in DESTRUCTIVE_COMMANDS:
            return safe_jsonify(build_confirmation(ai_cmd, ai_params, user["id"]))

        result = execute_command(ai_cmd, ai_params, owner, gh_token, vc_token, nl_token, rd_token)
        result["source"] = "ai"
        result["action_command"] = ai_cmd
        return safe_jsonify(result)

    return safe_jsonify({"reply": ai_text, "action": "message", "source": "ai"})


@app.route("/download", methods=["GET"])
def download_file():
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
        msg = r.json().get("message", "File nahi mili")
        return safe_jsonify({"reply": f"❌ GitHub: {msg}", "action": "error"}), r.status_code
    file_data = r.json()
    if file_data.get("type") != "file":
        return safe_jsonify({"reply": "❌ Ye path ek file nahi hai.", "action": "error"}), 400
    raw_bytes = base64.b64decode(file_data["content"])
    filename = path.split("/")[-1]
    import mimetypes
    mime, _ = mimetypes.guess_type(filename)
    if not mime:
        mime = "application/octet-stream"
    from flask import Response
    return Response(
        raw_bytes, status=200,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Type": mime,
            "Content-Length": str(len(raw_bytes)),
        }
    )


@app.route("/download-repo-zip", methods=["GET"])
def download_repo_zip():
    user = current_user()
    if not user:
        return safe_jsonify({"reply": "❌ Login chahiye.", "action": "error"}), 401
    gh_token = decrypt_token(user["github_token_encrypted"])
    owner = user["github_login"]

    repo = (request.args.get("repo") or "").strip()
    branch = (request.args.get("branch") or "").strip()
    if not repo:
        return safe_jsonify({"reply": "❌ repo naam chahiye.", "action": "error"}), 400

    if not branch:
        repo_r = gh_api("GET", f"/repos/{owner}/{repo}", gh_token)
        if repo_r.status_code != 200:
            return safe_jsonify({"reply": "❌ Repo nahi mila.", "action": "error"}), repo_r.status_code
        branch = repo_r.json().get("default_branch", "main")

    r = gh_api("GET", f"/repos/{owner}/{repo}/zipball/{branch}", gh_token)
    if r.status_code != 200:
        return safe_jsonify({"reply": f"❌ Zip download nahi hui (status {r.status_code}).", "action": "error"}), r.status_code

    from flask import Response
    filename = f"{repo}-{branch}.zip"
    return Response(
        r.content, status=200,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Type": "application/zip",
            "Content-Length": str(len(r.content)),
        }
    )


MAX_UPLOAD_BYTES = 25 * 1024 * 1024


@app.route("/upload", methods=["POST"])
def upload_file():
    user = current_user()
    if not user:
        return safe_jsonify({"reply": "❌ Login chahiye.", "action": "error", "source": "direct"}), 401
    gh_token = decrypt_token(user["github_token_encrypted"])
    owner = user["github_login"]

    repo = (request.form.get("repo") or "").strip()
    path = (request.form.get("path") or "").strip().lstrip("/")
    message = (request.form.get("message") or "").strip()
    f = request.files.get("file")

    if not repo:
        return safe_jsonify({"reply": "❌ Repo naam nahi diya.", "action": "error", "source": "direct"}), 400
    if not f or f.filename == "":
        return safe_jsonify({"reply": "❌ Koi file select nahi hui.", "action": "error", "source": "direct"}), 400
    if not path:
        path = f.filename

    raw = f.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        size_mb = len(raw) / (1024 * 1024)
        return safe_jsonify({
            "reply": f"❌ File bahut badi hai ({size_mb:.1f} MB). 25MB tak hi supported hai.",
            "action": "error", "source": "direct"
        }), 413

    if not message:
        message = f"Upload {path} via DevOps Agent"

    content_b64 = base64.b64encode(raw).decode()
    existing_sha = get_file_sha(repo, path, owner, gh_token)
    payload = {"message": message, "content": content_b64}
    if existing_sha:
        payload["sha"] = existing_sha

    r = gh_api("PUT", f"/repos/{owner}/{repo}/contents/{path}", gh_token, json=payload)
    if r.status_code in (200, 201):
        url = r.json()["content"]["html_url"]
        action = "update_file" if existing_sha else "create_file"
        verb = "Update" if existing_sha else "Upload"
        size_kb = len(raw) / 1024
        return safe_jsonify({
            "reply": f"✅ File {verb} ho gayi!\n**{path}** ({size_kb:.1f} KB)\n🔗 {url}",
            "action": action, "url": url, "repo": repo, "source": "direct"
        })
    else:
        err_msg = "File upload nahi hui"
        try:
            err_msg = r.json().get("message", err_msg)
        except Exception:
            pass
        return safe_jsonify({"reply": f"❌ GitHub Error: {err_msg}", "action": "error", "source": "direct"}), r.status_code


# ════════════════════════════════════════════════════════════════
#  ZIP UPLOAD → EXTRACT → PUSH AS ONE COMMIT
#  Same Git Data API approach as the personal agent (blobs → tree →
#  commit → ref update = one commit for the whole zip), but every
#  call is threaded through the logged-in user's own owner/gh_token —
#  never a shared credential.
# ════════════════════════════════════════════════════════════════
MAX_ZIP_BYTES = 25 * 1024 * 1024
MAX_ZIP_ENTRIES = 300


@app.route("/upload-zip", methods=["POST"])
def upload_zip():
    import zipfile
    import io

    user = current_user()
    if not user:
        return safe_jsonify({"reply": "❌ Login chahiye.", "action": "error", "source": "direct"}), 401
    gh_token = decrypt_token(user["github_token_encrypted"])
    owner = user["github_login"]

    repo = (request.form.get("repo") or "").strip()
    dest_dir = (request.form.get("path") or "").strip().strip("/")
    message = (request.form.get("message") or "").strip()
    f = request.files.get("file")

    if not repo:
        return safe_jsonify({"reply": "❌ Repo naam nahi diya.", "action": "error", "source": "direct"}), 400
    if not f or f.filename == "":
        return safe_jsonify({"reply": "❌ Koi zip file select nahi hui.", "action": "error", "source": "direct"}), 400
    if not f.filename.lower().endswith(".zip"):
        return safe_jsonify({"reply": "❌ Ye zip file nahi lag rahi. `.zip` extension chahiye.", "action": "error", "source": "direct"}), 400

    raw = f.read()
    if len(raw) > MAX_ZIP_BYTES:
        size_mb = len(raw) / (1024 * 1024)
        return safe_jsonify({
            "reply": f"❌ Zip bahut badi hai ({size_mb:.1f} MB). 25MB tak hi supported hai.",
            "action": "error", "source": "direct"
        }), 413

    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        return safe_jsonify({"reply": "❌ Zip file corrupt hai ya invalid format hai.", "action": "error", "source": "direct"}), 400

    entries = [n for n in zf.namelist() if not n.endswith("/")]
    top_level_parts = {n.split("/")[0] for n in entries if "/" in n}
    if len(top_level_parts) == 1 and all(n.startswith(next(iter(top_level_parts)) + "/") for n in entries):
        strip_prefix = next(iter(top_level_parts)) + "/"
        entries_map = {n[len(strip_prefix):]: n for n in entries}
    else:
        entries_map = {n: n for n in entries}

    JUNK_PATTERNS = ("__MACOSX/", ".DS_Store", "Thumbs.db")
    entries_map = {clean: orig for clean, orig in entries_map.items()
                   if clean and not any(j in orig for j in JUNK_PATTERNS)}

    if not entries_map:
        return safe_jsonify({"reply": "❌ Zip me koi usable file nahi mili.", "action": "error", "source": "direct"}), 400

    if len(entries_map) > MAX_ZIP_ENTRIES:
        return safe_jsonify({
            "reply": f"❌ Zip me {len(entries_map)} files hain — {MAX_ZIP_ENTRIES} se zyada ek baar me support nahi hai.",
            "action": "error", "source": "direct"
        }), 413

    if not message:
        message = f"Extract {f.filename} via DevOps Agent ({len(entries_map)} files)"

    repo_r = gh_api("GET", f"/repos/{owner}/{repo}", gh_token)
    if repo_r.status_code != 200:
        msg = repo_r.json().get("message", "Repo nahi mila") if repo_r.content else "Repo nahi mila"
        return safe_jsonify({"reply": f"❌ GitHub: {msg}", "action": "error", "source": "direct"}), repo_r.status_code
    default_branch = repo_r.json().get("default_branch", "main")

    ref_r = gh_api("GET", f"/repos/{owner}/{repo}/git/ref/heads/{default_branch}", gh_token)
    if ref_r.status_code != 200:
        return safe_jsonify({"reply": "❌ Base branch ref nahi mila.", "action": "error", "source": "direct"}), 400
    base_commit_sha = ref_r.json()["object"]["sha"]

    base_commit_r = gh_api("GET", f"/repos/{owner}/{repo}/git/commits/{base_commit_sha}", gh_token)
    if base_commit_r.status_code != 200:
        return safe_jsonify({"reply": "❌ Base commit nahi mila.", "action": "error", "source": "direct"}), 400
    base_tree_sha = base_commit_r.json()["tree"]["sha"]

    tree_entries = []
    for clean_path, orig_name in entries_map.items():
        file_bytes = zf.read(orig_name)
        full_path = f"{dest_dir}/{clean_path}" if dest_dir else clean_path
        content_b64 = base64.b64encode(file_bytes).decode()
        blob_r = gh_api("POST", f"/repos/{owner}/{repo}/git/blobs", gh_token,
                         json={"content": content_b64, "encoding": "base64"})
        if blob_r.status_code != 201:
            err = blob_r.json().get("message", "blob create failed") if blob_r.content else "blob create failed"
            return safe_jsonify({"reply": f"❌ `{clean_path}` upload karte time error: {err}",
                                  "action": "error", "source": "direct"}), 500
        blob_sha = blob_r.json()["sha"]
        tree_entries.append({"path": full_path, "mode": "100644", "type": "blob", "sha": blob_sha})

    tree_r = gh_api("POST", f"/repos/{owner}/{repo}/git/trees", gh_token,
                     json={"base_tree": base_tree_sha, "tree": tree_entries})
    if tree_r.status_code != 201:
        err = tree_r.json().get("message", "tree create failed") if tree_r.content else "tree create failed"
        return safe_jsonify({"reply": f"❌ Tree create Error: {err}", "action": "error", "source": "direct"}), 500
    new_tree_sha = tree_r.json()["sha"]

    commit_r = gh_api("POST", f"/repos/{owner}/{repo}/git/commits", gh_token,
                       json={"message": message, "tree": new_tree_sha, "parents": [base_commit_sha]})
    if commit_r.status_code != 201:
        err = commit_r.json().get("message", "commit create failed") if commit_r.content else "commit create failed"
        return safe_jsonify({"reply": f"❌ Commit create Error: {err}", "action": "error", "source": "direct"}), 500
    new_commit_sha = commit_r.json()["sha"]

    update_ref_r = gh_api("PATCH", f"/repos/{owner}/{repo}/git/refs/heads/{default_branch}", gh_token,
                           json={"sha": new_commit_sha})
    if update_ref_r.status_code != 200:
        err = update_ref_r.json().get("message", "ref update failed") if update_ref_r.content else "ref update failed"
        return safe_jsonify({"reply": f"❌ Branch update Error: {err}", "action": "error", "source": "direct"}), 500

    repo_url = repo_r.json().get("html_url", "")
    dest_display = f"{repo}/{dest_dir}" if dest_dir else repo
    file_list_preview = "\n".join(f"• {p}" for p in sorted(entries_map.keys())[:15])
    more_note = f"\n… +{len(entries_map) - 15} more" if len(entries_map) > 15 else ""

    return safe_jsonify({
        "reply": f"✅ Zip extract ho gayi aur push ho gayi!\n**{len(entries_map)} files** → `{dest_display}`\n\n{file_list_preview}{more_note}\n\n🔗 {repo_url}/tree/{default_branch}/{dest_dir if dest_dir else ''}",
        "action": "create_file", "repo": repo, "source": "direct", "file_count": len(entries_map)
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=(os.getenv("FLASK_ENV") == "development"))
