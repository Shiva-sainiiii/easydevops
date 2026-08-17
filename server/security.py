"""
SECRET REDACTION — defense in depth.

Scrubs whatever the CURRENT REQUEST's user token looks like before any
JSON response leaves the server — since tokens are per-user and not
fixed at startup, this redacts by pattern shape (GitHub PAT/OAuth token
formats, OpenRouter/Render key shapes) rather than a fixed known list,
plus whatever token was actually decrypted to serve this request.

Also home to safe_repo_path(), the path-traversal guard used by every
GitHub write surface (CREATE_FILE/EDIT_FILE/DELETE_FILE, the multi-file
codegen commit, /upload, /upload-zip) — it's "security" in the same
defense-in-depth sense as redaction, even though it guards writes rather
than response bodies.
"""
import re
from flask import jsonify

from server.config import GITHUB_CLIENT_SECRET, OPENROUTER_KEY, FERNET_KEY, FLASK_SECRET_KEY, DATABASE_URL
from server.auth import current_user
from server.db import decrypt_token, get_user_vercel_token, get_user_netlify_token, get_user_render_token

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


class UnsafePathError(ValueError):
    """Raised by safe_repo_path() when a path can't be trusted as staying
    inside the target repo — see that function for what's rejected."""
    pass


def safe_repo_path(raw_path):
    """Normalizes and validates a path before it's used in any GitHub
    contents/tree API call. Every write surface (CREATE_FILE, EDIT_FILE,
    DELETE_FILE, the multi-file CODE_GENERATE commit, /upload,
    /upload-zip) MUST route the caller-supplied path through this before
    using it — a path like "../../.github/workflows/evil.yml" (typed by a
    user, emitted by AI codegen, or embedded in a malicious zip entry
    name) would otherwise be committed exactly where its ".." segments
    pointed, since GitHub's Git Data API does not itself sandbox ".." in
    tree/content paths the way a filesystem call would.

    Rejects (raises UnsafePathError):
      - empty path after stripping
      - any path containing a literal ".." segment (traversal)
      - absolute-looking paths (leading "/" is stripped first, but also
        reject a leading "~" or a drive letter like "C:" defensively)
      - paths rooted at ".github/" — this app's own CI config living in
        the same repo namespace as user content is exactly the kind of
        target this function exists to protect, so it's blocked outright
        rather than merely traversal-checked.

    Returns the cleaned, forward-slash path on success.
    """
    if raw_path is None:
        raise UnsafePathError("path missing")
    path = str(raw_path).strip().replace("\\", "/")
    path = path.lstrip("/")
    if not path:
        raise UnsafePathError("path empty")
    if path.startswith("~") or re.match(r"^[a-zA-Z]:", path):
        raise UnsafePathError("absolute-looking path not allowed")

    segments = path.split("/")
    cleaned = []
    for seg in segments:
        if seg in ("", "."):
            continue
        if seg == "..":
            raise UnsafePathError("path traversal ('..') not allowed")
        cleaned.append(seg)
    if not cleaned:
        raise UnsafePathError("path empty after normalization")
    if cleaned[0] == ".github":
        raise UnsafePathError("writes under .github/ are not allowed via chat/codegen")

    return "/".join(cleaned)
