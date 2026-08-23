"""
File-level routes: single-file download, whole-repo zip download,
single-file upload, and the zip-upload → extract → push-as-one-commit
flow (ZIP UPLOAD section) — the "zip slip" fix lives in the loop that
builds tree_entries below: every entry's path is passed through
safe_repo_path() before it's allowed into the Git tree, since a zip
entry's internal name is attacker-controlled (a crafted archive can
contain an entry literally named "../../.github/workflows/evil.yml").
"""
import io
import zipfile
import base64
import mimetypes
from flask import Blueprint, request, Response

from server.auth import current_user
from server.db import decrypt_token
from server.security import safe_jsonify, safe_repo_path, UnsafePathError
from server.providers.github import gh_api, get_file_sha

file_bp = Blueprint("file_routes", __name__)


@file_bp.route("/download", methods=["GET"])
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
    mime, _ = mimetypes.guess_type(filename)
    if not mime:
        mime = "application/octet-stream"
    return Response(
        raw_bytes, status=200,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Type": mime,
            "Content-Length": str(len(raw_bytes)),
        }
    )


@file_bp.route("/download-repo-zip", methods=["GET"])
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


@file_bp.route("/upload", methods=["POST"])
def upload_file():
    user = current_user()
    if not user:
        return safe_jsonify({"reply": "❌ Login chahiye.", "action": "error", "source": "direct"}), 401
    gh_token = decrypt_token(user["github_token_encrypted"])
    owner = user["github_login"]

    repo = (request.form.get("repo") or "").strip()
    path = (request.form.get("path") or "").strip()
    message = (request.form.get("message") or "").strip()
    f = request.files.get("file")

    if not repo:
        return safe_jsonify({"reply": "❌ Repo naam nahi diya.", "action": "error", "source": "direct"}), 400
    if not f or f.filename == "":
        return safe_jsonify({"reply": "❌ Koi file select nahi hui.", "action": "error", "source": "direct"}), 400
    if not path:
        path = f.filename
    try:
        path = safe_repo_path(path)
    except UnsafePathError as e:
        return safe_jsonify({"reply": f"❌ Ye path allowed nahi hai: {e}", "action": "error", "source": "direct"}), 400

    raw = f.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        size_mb = len(raw) / (1024 * 1024)
        return safe_jsonify({
            "reply": f"❌ File bahut badi hai ({size_mb:.1f} MB). 25MB tak hi supported hai.",
            "action": "error", "source": "direct"
        }), 413

    if not message:
        message = f"Upload {path} via Easy DevOps"

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


@file_bp.route("/upload-zip", methods=["POST"])
def upload_zip():
    user = current_user()
    if not user:
        return safe_jsonify({"reply": "❌ Login chahiye.", "action": "error", "source": "direct"}), 401
    gh_token = decrypt_token(user["github_token_encrypted"])
    owner = user["github_login"]

    repo = (request.form.get("repo") or "").strip()
    dest_dir_raw = (request.form.get("path") or "").strip().strip("/")
    message = (request.form.get("message") or "").strip()
    f = request.files.get("file")

    if not repo:
        return safe_jsonify({"reply": "❌ Repo naam nahi diya.", "action": "error", "source": "direct"}), 400
    if not f or f.filename == "":
        return safe_jsonify({"reply": "❌ Koi zip file select nahi hui.", "action": "error", "source": "direct"}), 400
    if not f.filename.lower().endswith(".zip"):
        return safe_jsonify({"reply": "❌ Ye zip file nahi lag rahi. `.zip` extension chahiye.", "action": "error", "source": "direct"}), 400

    dest_dir = ""
    if dest_dir_raw:
        try:
            dest_dir = safe_repo_path(dest_dir_raw)
        except UnsafePathError as e:
            return safe_jsonify({"reply": f"❌ Destination folder allowed nahi hai: {e}", "action": "error", "source": "direct"}), 400

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
        message = f"Extract {f.filename} via Easy DevOps ({len(entries_map)} files)"

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
    zip_skipped = []
    for clean_path, orig_name in entries_map.items():
        raw_full_path = f"{dest_dir}/{clean_path}" if dest_dir else clean_path
        try:
            full_path = safe_repo_path(raw_full_path)
        except UnsafePathError:
            # A zip entry name itself can contain "../" (this is the
            # classic "zip slip" attack: a crafted archive whose internal
            # entry names point outside the intended extraction root).
            # Previously full_path was used as-is with no check, so such
            # an entry would be committed exactly where its ".." pointed
            # inside the repo tree. Skip just this entry rather than fail
            # the whole upload.
            zip_skipped.append(clean_path)
            continue
        file_bytes = zf.read(orig_name)
        content_b64 = base64.b64encode(file_bytes).decode()
        blob_r = gh_api("POST", f"/repos/{owner}/{repo}/git/blobs", gh_token,
                         json={"content": content_b64, "encoding": "base64"})
        if blob_r.status_code != 201:
            err = blob_r.json().get("message", "blob create failed") if blob_r.content else "blob create failed"
            return safe_jsonify({"reply": f"❌ `{clean_path}` upload karte time error: {err}",
                                  "action": "error", "source": "direct"}), 500
        blob_sha = blob_r.json()["sha"]
        tree_entries.append({"path": full_path, "mode": "100644", "type": "blob", "sha": blob_sha})

    if not tree_entries:
        return safe_jsonify({"reply": "❌ Zip me koi safe/usable file nahi mili (saare entries unsafe paths the).",
                              "action": "error", "source": "direct"}), 400

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
    skip_note = f"\n\n⚠️ Unsafe path hone ki wajah se skip hui: {', '.join(zip_skipped)}" if zip_skipped else ""

    return safe_jsonify({
        "reply": f"✅ Zip extract ho gayi aur push ho gayi!\n**{len(tree_entries)} files** → `{dest_display}`\n\n{file_list_preview}{more_note}{skip_note}\n\n🔗 {repo_url}/tree/{default_branch}/{dest_dir if dest_dir else ''}",
        "action": "create_file", "repo": repo, "source": "direct", "file_count": len(tree_entries)
    })
