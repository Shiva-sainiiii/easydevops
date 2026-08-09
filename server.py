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
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                )
            """)


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
        tok = decrypt_token(user["github_token_encrypted"])
        if tok:
            extra.append(tok)

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
    })


def gh_api(method, endpoint, gh_token, **kwargs):
    url = f"https://api.github.com{endpoint}"
    headers = {
        "Authorization": f"Bearer {gh_token}",
        "Accept": "application/vnd.github+json",
    }
    return requests.request(method, url, headers=headers, timeout=20, **kwargs)


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
DESTRUCTIVE_COMMANDS = {"DELETE_REPO", "DELETE_FILE"}


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
    else:
        target_desc = str(params)
        warn_text = "Ye action wapas nahi ho sakta."

    return {
        "reply": f"⚠️ **Pakka?**\n\n{target_desc} delete karne wala hu (tumhare GitHub account se).\n\n{warn_text}",
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
def execute_command(cmd, params, owner, gh_token):
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
                return {"reply": f"Tere {len(repos)} repos:\n\n" + "\n\n".join(lines), "action": "list_repos",
                        "repos": [{"name": rp["name"], "url": rp["html_url"]} for rp in repos]}
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

NO_ARG_COMMANDS = {"LIST_REPOS"}


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
    for cmd, patterns, extractor in INTENT_RULES:
        for pat in patterns:
            m = re.search(pat, lowered)
            if m:
                try:
                    params = extractor(m)
                except Exception:
                    continue
                required_fields = {"repo"}
                if any(params.get(f) in (None, "") for f in required_fields if f in params):
                    continue
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
You control ONLY this user's own GitHub account. You act by outputting EXACTLY ONE command per response.

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

RULES:
- Output ONLY the command, nothing else, UNLESS the request is conversational/explanatory.
- JSON must be valid. Escape quotes as \\" and newlines as \\n in content fields.
- NEVER invent URLs, IDs, or data you don't have — only the 9 commands above give you real information.
- NEVER output anything resembling a real token/secret, even as an example.
"""

CODEGEN_SYSTEM_PROMPT = """You generate file content for a developer tool. Output ONLY the raw file content — no markdown fences, no explanation. Write complete, working code. Infer language from the file path."""

COMMANDS = [
    "CREATE_REPO:", "DELETE_REPO:", "LIST_REPOS", "CREATE_FILE:",
    "READ_FILE:", "EDIT_FILE:", "DELETE_FILE:", "LIST_FILES:", "GET_REPO_INFO:",
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


def call_openrouter_chat(user_message, history, github_login):
    messages = [{"role": "system", "content": SYSTEM_PROMPT_TEMPLATE.format(login=github_login)}]
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
        result = execute_command(cmd, params, owner, gh_token)
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

        result = execute_command(cmd, params, owner, gh_token)
        result["source"] = "direct"
        result["action_command"] = cmd
        return safe_jsonify(result)

    # 3. AI FALLBACK
    try:
        ai_text = call_openrouter_chat(user_message, conv_history, owner)
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

        result = execute_command(ai_cmd, ai_params, owner, gh_token)
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
