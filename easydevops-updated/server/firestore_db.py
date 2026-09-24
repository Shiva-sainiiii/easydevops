"""
CHAT SESSION STORE — Firestore.

Replaces the old client-only localStorage session store: chat history
used to live entirely in the browser, so a cleared cache / new device /
reinstalled app meant every conversation was gone. This module persists
the exact same {sessions, activeSessionId} shape server-side instead, so
it survives all of that.

Firestore is used purely as a document store here, reached ONLY through
the Firebase Admin SDK from this backend — never from client-side JS, and
NOT via Firebase Authentication. Login/identity is already fully handled
by the existing GitHub OAuth + signed-cookie system (see server/auth.py);
adding Firebase Auth on top would mean juggling two separate identity
systems for no benefit. Every session here is keyed by the same
`user_id` (Postgres users.id) that already comes out of the session
cookie, so this plugs into the existing auth model instead of replacing
it. Because writes only ever happen from this trusted backend (which
already verified the user via the signed cookie), Firestore security
rules for this project can — and should — simply deny all direct
client access (`allow read, write: if false;`); the Admin SDK bypasses
rules entirely, so locking them down doesn't break anything here.

Collection layout:
  chat_sessions/{user_id}/sessions/{session_id}
    -> {id, title, messages: [...], updatedAt}
  A separate small doc chat_sessions/{user_id} holds just
  {activeSessionId} so "which session is open" persists too.

init_firestore() has a side effect (initializes the Admin SDK app) and is
called once from server/__init__.py at startup — NOT at import time here,
mirroring db.py's init_db() pattern, so importing this module is always
side-effect-free.
"""
import json
import firebase_admin
from firebase_admin import credentials, firestore

from server.config import FIREBASE_SERVICE_ACCOUNT_JSON

SESSIONS_MAX = 50          # mirrors the old localStorage SESSIONS_MAX
SESSION_MSG_MAX = 200      # mirrors the old localStorage SESSION_MSG_MAX

_app = None
_db = None


def init_firestore():
    global _app, _db
    if _app is not None:
        return  # already initialized (e.g. re-imported across serverless invocations)
    try:
        service_account_info = json.loads(FIREBASE_SERVICE_ACCOUNT_JSON)
    except (json.JSONDecodeError, TypeError) as e:
        raise RuntimeError(
            "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON — paste the *entire* contents "
            "of the downloaded service-account key file as-is, not a file path."
        ) from e
    cred = credentials.Certificate(service_account_info)
    _app = firebase_admin.initialize_app(cred)
    _db = firestore.client()


def _sessions_collection(user_id):
    return _db.collection("chat_sessions").document(str(user_id)).collection("sessions")


def _meta_doc(user_id):
    return _db.collection("chat_sessions").document(str(user_id))


def _epoch_ms(value):
    """Firestore SERVER_TIMESTAMP round-trips as a datetime (google.cloud
    firestore's DatetimeWithNanoseconds) once read back, which JSON-
    serializes to an ISO string via Flask's default encoder. The frontend
    (timeAgo(), the sessions.sort() in renderChatHistoryList) expects a
    plain numeric epoch-milliseconds value — same shape Date.now() has
    always produced there — so every timestamp is normalized to that
    shape here, at the one place data leaves Firestore's type system and
    enters the JSON API contract the frontend already relies on."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return value
    # datetime / DatetimeWithNanoseconds both support timestamp()
    try:
        return int(value.timestamp() * 1000)
    except AttributeError:
        return None


def _normalize_session(doc_dict):
    doc_dict["updatedAt"] = _epoch_ms(doc_dict.get("updatedAt"))
    return doc_dict


def get_sessions_state(user_id):
    """Returns {sessions: [...], activeSessionId} for this user — same
    shape the old localStorage SESSIONS_KEY blob had, so the frontend's
    existing rendering code needs minimal changes."""
    docs = (
        _sessions_collection(user_id)
        .order_by("updatedAt", direction=firestore.Query.DESCENDING)
        .limit(SESSIONS_MAX)
        .stream()
    )
    sessions = [_normalize_session(d.to_dict()) for d in docs]

    meta = _meta_doc(user_id).get()
    active_id = meta.to_dict().get("activeSessionId") if meta.exists else None

    # If the saved active id doesn't point at a session we actually have
    # (deleted, or this is a first-ever load), fall back to the most
    # recent one rather than surfacing an empty chat unnecessarily.
    if not active_id or not any(s["id"] == active_id for s in sessions):
        active_id = sessions[0]["id"] if sessions else None

    return {"sessions": sessions, "activeSessionId": active_id}


def create_session(user_id, session_id, title="Nayi Chat"):
    doc = {"id": session_id, "title": title, "messages": [], "updatedAt": firestore.SERVER_TIMESTAMP}
    _sessions_collection(user_id).document(session_id).set(doc)
    set_active_session(user_id, session_id)
    return doc


def append_message(user_id, session_id, entry):
    """Appends one message to a session, trims to SESSION_MSG_MAX, bumps
    updatedAt, and — if this is the session's first user message — sets
    the title from it. Mirrors saveChatEntry()'s old localStorage logic."""
    ref = _sessions_collection(user_id).document(session_id)
    snap = ref.get()
    if not snap.exists:
        create_session(user_id, session_id)
        snap = ref.get()

    data = snap.to_dict()
    messages = data.get("messages", [])
    messages.append(entry)
    if len(messages) > SESSION_MSG_MAX:
        messages = messages[-SESSION_MSG_MAX:]

    update = {"messages": messages, "updatedAt": firestore.SERVER_TIMESTAMP}
    if len(messages) == 1 and entry.get("role") == "user":
        title = entry.get("content", "").strip().replace("\n", " ")
        update["title"] = (title[:42] + "…") if len(title) > 42 else title

    ref.update(update)


def set_active_session(user_id, session_id):
    _meta_doc(user_id).set({"activeSessionId": session_id}, merge=True)


def delete_session(user_id, session_id):
    _sessions_collection(user_id).document(session_id).delete()


def clear_session_messages(user_id, session_id):
    _sessions_collection(user_id).document(session_id).update({
        "messages": [], "title": "Nayi Chat", "updatedAt": firestore.SERVER_TIMESTAMP,
    })
