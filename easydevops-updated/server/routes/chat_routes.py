"""
/chat — the main command entrypoint. Three-stage dispatch:
  1. Confirmed destructive-action replay (from a prior confirm_required)
  2. Structural intent match (regex) → direct execution, or the two
     AI-assisted paths (CREATE_FILE/EDIT_FILE content-gen, CODE_GENERATE
     multi-file build/edit)
  3. Full AI fallback when no regex rule matched at all
"""
import json
import requests
from flask import Blueprint, request, make_response

from server.auth import current_user
from server.db import decrypt_token, delete_user, get_user_vercel_token, get_user_netlify_token, get_user_render_token
from server.security import safe_jsonify
from server.auth import clear_session_cookie
from server.commands.confirmation import DESTRUCTIVE_COMMANDS, confirm_token, build_confirmation
from server.commands.executor import execute_command
from server.commands.intent_parser import parse_intent, NO_ARG_COMMANDS
from server.commands.ai_fallback import call_openrouter_chat, extract_command, handle_create_or_edit_file
from server.commands.code_generate import handle_code_generate
from server.commands.render_blueprint import generate_render_yaml

chat_bp = Blueprint("chat_routes", __name__)


@chat_bp.route("/chat", methods=["POST"])
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

        if cmd == "GENERATE_RENDER_YAML":
            try:
                result = generate_render_yaml(params["repo"], owner, gh_token)
                result["source"] = "direct"
                return safe_jsonify(result)
            except Exception as e:
                return safe_jsonify({"reply": f"❌ Error: {str(e)}", "action": "error", "source": "direct"})

        if cmd == "CODE_GENERATE":
            try:
                params["instruction"] = user_message
                result = handle_code_generate(params, owner, gh_token)
                return safe_jsonify(result)
            except RuntimeError as e:
                return safe_jsonify({"reply": f"❌ AI Error: {str(e)}", "action": "error", "source": "hybrid"})
            except requests.Timeout:
                return safe_jsonify({"reply": "AI ne code generate karne me bahut time lagaya. Dobara try karo 🔄", "action": "error", "source": "hybrid"})
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
