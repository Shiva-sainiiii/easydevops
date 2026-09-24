"""
/api/sessions/* — chat session persistence, backed by Firestore
(server/firestore_db.py). Replaces the old approach where all of this
lived only in the browser's localStorage — every route here is scoped to
`current_user()["id"]`, so a request can only ever touch that user's own
sessions, the same trust boundary every other authenticated route in this
app already uses (see chat_routes.py, provider_routes.py).
"""
import uuid
from flask import Blueprint, request

from server.auth import current_user
from server.security import safe_jsonify
import server.firestore_db as fdb

session_bp = Blueprint("session_routes", __name__)


def _require_user():
    user = current_user()
    if not user:
        return None, (safe_jsonify({"reply": "🔒 Pehle GitHub se connect karo.", "action": "auth_required"}), 401)
    return user, None


@session_bp.route("/api/sessions", methods=["GET"])
def list_sessions():
    """Returns {sessions: [...], activeSessionId} — same shape the old
    localStorage SESSIONS_KEY blob had, so the frontend just swaps its
    storage source, not its rendering logic."""
    user, err = _require_user()
    if err:
        return err
    state = fdb.get_sessions_state(user["id"])
    return safe_jsonify(state)


@session_bp.route("/api/sessions", methods=["POST"])
def new_session():
    """Creates a fresh empty session and makes it the active one —
    mirrors the old startNewChatSession()."""
    user, err = _require_user()
    if err:
        return err
    session_id = "sess_" + uuid.uuid4().hex[:16]
    doc = fdb.create_session(user["id"], session_id)
    return safe_jsonify(doc)


@session_bp.route("/api/sessions/<session_id>/messages", methods=["POST"])
def append_session_message(session_id):
    """Appends one message ({role, content, actionClass, ts, action,
    repo, path, items, repos, projects, sites, services}) to a session.
    Called once per message right after /chat responds — kept as a
    separate call (rather than folded into /chat itself) so the frontend
    can still render instantly and persist in the background without
    blocking on it."""
    user, err = _require_user()
    if err:
        return err
    entry = request.json or {}
    fdb.append_message(user["id"], session_id, entry)
    return safe_jsonify({"ok": True})


@session_bp.route("/api/sessions/<session_id>/active", methods=["POST"])
def set_active(session_id):
    user, err = _require_user()
    if err:
        return err
    fdb.set_active_session(user["id"], session_id)
    return safe_jsonify({"ok": True})


@session_bp.route("/api/sessions/<session_id>", methods=["DELETE"])
def delete_session_route(session_id):
    user, err = _require_user()
    if err:
        return err
    fdb.delete_session(user["id"], session_id)
    return safe_jsonify({"ok": True})


@session_bp.route("/api/sessions/<session_id>/clear", methods=["POST"])
def clear_session_route(session_id):
    """Wipes messages but keeps the session doc — mirrors the old
    clearSavedChat()."""
    user, err = _require_user()
    if err:
        return err
    fdb.clear_session_messages(user["id"], session_id)
    return safe_jsonify({"ok": True})
