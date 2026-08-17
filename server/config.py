"""
App-level configuration: env vars and constants only.

These are the ONLY secrets that live in this server's own env — they
identify the *app itself* to GitHub's OAuth system, not any individual
user. No user's GitHub/Vercel/Render token ever goes in an env var; those
are per-user and stored encrypted in Postgres (see db.py).

WHY POSTGRES + SIGNED COOKIES INSTEAD OF SQLITE + SERVER SESSIONS:
Vercel runs this app as serverless functions — every request gets a
fresh, isolated filesystem with no shared memory or disk between
invocations. A SQLite file written during one request is gone by the
next; Flask's default server-side session (which also needs somewhere
persistent to live) has the same problem. So:
  - Token storage moves to Neon (managed Postgres) — a real network
    database that persists independently of any single invocation.
  - The session itself becomes STATELESS: instead of storing "user_id"
    server-side and giving the browser an opaque pointer to it, we put
    the user_id directly in the cookie, signed with itsdangerous so it
    can't be forged or tampered with. No server lookup needed to know
    who's asking — just signature verification.

This module has no Flask app instance and no route handlers — it's safe
to import from anywhere without circular-import risk.
"""
import os
from dotenv import load_dotenv

load_dotenv()

FLASK_SECRET_KEY = os.getenv("FLASK_SECRET_KEY")          # signs the session cookie
FERNET_KEY = os.getenv("FERNET_KEY")                       # encrypts tokens at rest in postgres
GITHUB_CLIENT_ID = os.getenv("GITHUB_CLIENT_ID")
GITHUB_CLIENT_SECRET = os.getenv("GITHUB_CLIENT_SECRET")
OPENROUTER_KEY = os.getenv("OPENROUTER_KEY")                # still app-level: AI fallback is shared infra, not per-user
APP_BASE_URL = os.getenv("APP_BASE_URL", "http://localhost:5000")  # used to build the OAuth callback URL
DATABASE_URL = os.getenv("DATABASE_URL")                    # Neon Postgres connection string

if not FLASK_SECRET_KEY:
    raise RuntimeError("FLASK_SECRET_KEY env var missing — required to sign session cookies. Generate one with: python -c \"import secrets; print(secrets.token_hex(32))\"")
if not FERNET_KEY:
    raise RuntimeError("FERNET_KEY env var missing — required to encrypt stored tokens. Generate one with: python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\"")
if not GITHUB_CLIENT_ID or not GITHUB_CLIENT_SECRET:
    raise RuntimeError("GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET missing — register a GitHub OAuth App and set these.")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL env var missing — set this to your Neon Postgres connection string.")

IS_PROD = os.getenv("FLASK_ENV") != "development"
