"""
TOKEN STORE — Neon Postgres, encrypted at rest.

One row per logged-in user: their GitHub identity + their ENCRYPTED
GitHub/Vercel/Netlify/Render access tokens. Nothing here is readable
without FERNET_KEY, which lives only in this server's env — but the point
of the whole multi-tenant design is that even that key only decrypts
*tokens users voluntarily connected*, never a shared credential of yours.

init_db() has a side effect (creates/migrates the `users` table) and is
called once from server/__init__.py at app startup — NOT at import time
here, so importing this module is always safe/side-effect-free.
"""
import psycopg2
import psycopg2.extras
from contextlib import contextmanager
from cryptography.fernet import Fernet, InvalidToken

from server.config import DATABASE_URL, FERNET_KEY

fernet = Fernet(FERNET_KEY.encode() if isinstance(FERNET_KEY, str) else FERNET_KEY)


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
