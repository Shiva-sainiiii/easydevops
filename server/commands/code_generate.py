"""
CODE_GENERATE — multi-file agentic build/edit, ported from the CodeAgent
project's structured-JSON contract + diff-apply engine. Difference from
CodeAgent: there files live in the browser's localStorage and get applied
client-side; here they live in a GitHub repo, so "apply" means fetch
current content -> apply edits/creates in memory -> push everything as
ONE commit via the Git Data API (same blobs->tree->commit->ref pattern
/upload-zip uses — see routes/file_routes.py — factored out here as
commit_files_to_repo() so both share the same commit helper... note the
upload-zip route currently keeps its own copy inline rather than
importing this one, to avoid a routes<->commands import in that
direction; they're kept in sync manually).
"""
import re
import json
import base64
import requests

from server.config import OPENROUTER_KEY
from server.providers.github import gh_api
from server.security import safe_repo_path, UnsafePathError
from server.commands.ai_fallback import OPENROUTER_MODEL
from server.commands.intent_parser import (
    CODEGEN_INSPECT_VERBS_RE, CODEGEN_STRONG_CHANGE_VERBS_RE, CODEGEN_GENERIC_DO_RE,
)


MAX_CODEGEN_FILES = 20
CODEGEN_CONTEXT_CAP = 18000  # chars of existing-file content sent to the model

CODEGEN_MULTIFILE_SYSTEM_PROMPT = """You are an agentic coding assistant working inside a GitHub repo via a chat interface. The user works from their phone, in Hinglish (Hindi+English mix) or English — understand both.

Respond with ONLY a single JSON object, nothing else — no markdown fences, no preamble, no text outside the JSON.

JSON shape:
{
  "reply": "short chat message to show the user (can be Hinglish)",
  "reasoning": "1-3 short sentences explaining what you're about to do and why. Omit or leave empty if there are no file changes.",
  "files": [
    {
      "path": "relative/file/path.ext",
      "action": "create" | "edit",
      "content": "FULL file content — only for action=create, or for action=edit when the file is short (under ~40 lines)",
      "edits": [ { "find": "exact snippet from the current file content shown to you", "replace": "new snippet" } ]
    }
  ]
}

RULES:
1. action="create": always give full "content", omit "edits".
2. action="edit" on a file whose current content was shown to you: prefer "edits" — an array of {find, replace} where find is an exact, short, unique substring of the current content. Only fall back to full "content" for edits when the file is short (under ~40 lines) or the change touches most of the file.
3. If the user is asking to UNDERSTAND, EXPLAIN, REVIEW, or DESCRIBE existing code — not asking for anything to be built, changed, added, or fixed — respond with ONLY: {"reply": "your explanation here", "files": []}. Being shown file content does not mean you should regenerate it. Only include a non-empty "files" array when the message itself asks for a change.
4. Never invent file content you weren't asked for. Never touch files unrelated to the request.
5. MULTI-FILE PROJECTS MUST WORK TOGETHER: if you create/edit an HTML+CSS+JS trio, the HTML must correctly <link>/<script src> the exact filenames you used. Every id/class the JS queries must exist in the HTML. Every class the CSS styles must exist in the HTML.
6. Keep "reply" short (1-3 sentences). "reasoning" is shown before files are applied.
7. Maximum {max_files} files per response."""


def build_codegen_file_context(repo, owner, gh_token, instruction, existing_paths):
    """Fetches content for files plausibly relevant to `instruction`, capped by
    CODEGEN_CONTEXT_CAP chars total — mirrors CodeAgent's buildFileContext
    (mentioned-in-message files prioritized so a size cutoff drops the least
    relevant file first, not the one actually being edited)."""
    if not existing_paths:
        return ""
    lowered = instruction.lower()
    mentioned = [p for p in existing_paths if p.lower() in lowered or p.split("/")[-1].lower() in lowered]
    rest = [p for p in existing_paths if p not in mentioned]
    ordered = mentioned + rest

    out_parts = []
    total = 0
    for path in ordered[:30]:  # don't fetch an unbounded number of files for a huge repo
        r = gh_api("GET", f"/repos/{owner}/{repo}/contents/{path}", gh_token)
        if r.status_code != 200:
            continue
        file_data = r.json()
        if file_data.get("type") != "file" or file_data.get("size", 0) > 60000:
            continue
        try:
            content = base64.b64decode(file_data["content"]).decode("utf-8", errors="replace")
        except Exception:
            continue
        block = f"--- {path} ---\n{content}\n\n"
        if total + len(block) > CODEGEN_CONTEXT_CAP:
            out_parts.append(f"--- {path} --- (omitted for space, {len(content)} chars)\n\n")
            continue
        out_parts.append(block)
        total += len(block)
    return "".join(out_parts).strip()


def list_repo_paths(repo, owner, gh_token):
    """Recursive file listing via the Git Trees API (single call, unlike
    LIST_FILES's one-directory-at-a-time /contents listing) — used to give
    the model a picture of the whole repo, not just its root."""
    repo_r = gh_api("GET", f"/repos/{owner}/{repo}", gh_token)
    if repo_r.status_code != 200:
        return None, repo_r
    default_branch = repo_r.json().get("default_branch", "main")
    tree_r = gh_api("GET", f"/repos/{owner}/{repo}/git/trees/{default_branch}?recursive=1", gh_token)
    if tree_r.status_code != 200:
        return None, tree_r
    paths = [item["path"] for item in tree_r.json().get("tree", []) if item.get("type") == "blob"]
    return paths, repo_r


def call_openrouter_multifile(instruction, file_context):
    system_prompt = CODEGEN_MULTIFILE_SYSTEM_PROMPT.format(max_files=MAX_CODEGEN_FILES)
    user_content = f"Existing files:\n{file_context}\n\nRequest: {instruction}" if file_context else instruction
    ai_resp = requests.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={"Authorization": f"Bearer {OPENROUTER_KEY}", "Content-Type": "application/json"},
        json={
            "model": OPENROUTER_MODEL,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            "temperature": 0.3,
        },
        timeout=60,
    ).json()

    if "error" in ai_resp:
        raise RuntimeError(ai_resp["error"].get("message", "Unknown AI error"))
    raw = ai_resp["choices"][0]["message"]["content"].strip()
    raw = re.sub(r"^```(?:json)?\n", "", raw)
    raw = re.sub(r"\n```$", "", raw)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        # Model occasionally wraps the JSON in a sentence despite instructions —
        # try to recover by grabbing the outermost {...} span before giving up.
        m = re.search(r"\{.*\}", raw, re.S)
        if not m:
            raise RuntimeError("AI ne valid JSON nahi diya")
        data = json.loads(m.group(0))
    return data


def find_fuzzy_match(content, find):
    """Python port of CodeAgent's findFuzzyMatch: whitespace-tolerant substring
    search for when the model's `find` snippet drifts slightly (extra blank
    line, tabs vs spaces) from the real file content. Returns the exact
    substring of `content` to replace, or None."""
    if not find:
        return None

    def normalize(s):
        s = re.sub(r"[ \t]+", " ", s)
        s = re.sub(r"\s*\n\s*", "\n", s)
        return s.strip()

    norm_find = normalize(find)
    if not norm_find:
        return None

    lines = content.split("\n")
    find_line_count = find.count("\n") + 1

    for window_size in {find_line_count, find_line_count + 1, max(1, find_line_count - 1)}:
        for i in range(0, len(lines) - window_size + 1):
            candidate = "\n".join(lines[i:i + window_size])
            if normalize(candidate) == norm_find:
                return candidate
    return None


def apply_file_edits(existing_content, edits):
    """Python port of CodeAgent's applyFileOps edit-application logic for a
    single file. Returns (new_content, changed: bool, any_missed: bool)."""
    content = existing_content
    changed = False
    missed = False
    for e in edits or []:
        find = e.get("find")
        replace = e.get("replace", "")
        if not find:
            continue
        if find in content:
            content = content.replace(find, replace, 1)
            changed = True
            continue
        fuzzy = find_fuzzy_match(content, find)
        if fuzzy is not None:
            content = content.replace(fuzzy, replace, 1)
            changed = True
            continue
        missed = True
    return content, changed, missed


def commit_files_to_repo(owner, repo, gh_token, file_map, message):
    """Shared Git Data API commit helper (blobs -> tree -> commit -> ref
    update = one commit for N files), factored out of the /upload-zip route
    so CODE_GENERATE can push a multi-file AI response the same way instead
    of doing one PUT-per-file. file_map is {path: content_str}. Returns
    (ok: bool, reply_or_error: str, repo_url: str|None)."""
    repo_r = gh_api("GET", f"/repos/{owner}/{repo}", gh_token)
    if repo_r.status_code != 200:
        msg = repo_r.json().get("message", "Repo nahi mila") if repo_r.content else "Repo nahi mila"
        return False, msg, None
    default_branch = repo_r.json().get("default_branch", "main")
    repo_url = repo_r.json().get("html_url", "")

    ref_r = gh_api("GET", f"/repos/{owner}/{repo}/git/ref/heads/{default_branch}", gh_token)
    if ref_r.status_code != 200:
        return False, "Base branch ref nahi mila.", None
    base_commit_sha = ref_r.json()["object"]["sha"]

    base_commit_r = gh_api("GET", f"/repos/{owner}/{repo}/git/commits/{base_commit_sha}", gh_token)
    if base_commit_r.status_code != 200:
        return False, "Base commit nahi mila.", None
    base_tree_sha = base_commit_r.json()["tree"]["sha"]

    tree_entries = []
    for path, content in file_map.items():
        content_b64 = base64.b64encode(content.encode("utf-8")).decode()
        blob_r = gh_api("POST", f"/repos/{owner}/{repo}/git/blobs", gh_token,
                         json={"content": content_b64, "encoding": "base64"})
        if blob_r.status_code != 201:
            err = blob_r.json().get("message", "blob create failed") if blob_r.content else "blob create failed"
            return False, f"`{path}` ke liye blob create Error: {err}", None
        tree_entries.append({"path": path, "mode": "100644", "type": "blob", "sha": blob_r.json()["sha"]})

    tree_r = gh_api("POST", f"/repos/{owner}/{repo}/git/trees", gh_token,
                     json={"base_tree": base_tree_sha, "tree": tree_entries})
    if tree_r.status_code != 201:
        err = tree_r.json().get("message", "tree create failed") if tree_r.content else "tree create failed"
        return False, f"Tree create Error: {err}", None
    new_tree_sha = tree_r.json()["sha"]

    commit_r = gh_api("POST", f"/repos/{owner}/{repo}/git/commits", gh_token,
                       json={"message": message, "tree": new_tree_sha, "parents": [base_commit_sha]})
    if commit_r.status_code != 201:
        err = commit_r.json().get("message", "commit create failed") if commit_r.content else "commit create failed"
        return False, f"Commit create Error: {err}", None
    new_commit_sha = commit_r.json()["sha"]

    update_ref_r = gh_api("PATCH", f"/repos/{owner}/{repo}/git/refs/heads/{default_branch}", gh_token,
                           json={"sha": new_commit_sha})
    if update_ref_r.status_code != 200:
        err = update_ref_r.json().get("message", "ref update failed") if update_ref_r.content else "ref update failed"
        return False, f"Branch update Error: {err}", None

    return True, "", f"{repo_url}/tree/{default_branch}"


def handle_code_generate(params, owner, gh_token):
    repo = params["repo"]
    instruction = params["instruction"]

    existing_paths, repo_or_err = list_repo_paths(repo, owner, gh_token)
    if existing_paths is None:
        msg = repo_or_err.json().get("message", "Repo nahi mila") if repo_or_err.content else "Repo nahi mila"
        return {"reply": f"❌ GitHub: {msg}", "action": "error", "source": "hybrid"}

    file_context = build_codegen_file_context(repo, owner, gh_token, instruction, existing_paths)
    ai_data = call_openrouter_multifile(instruction, file_context)

    reply_text = ai_data.get("reply") or "…"
    reasoning = (ai_data.get("reasoning") or "").strip()
    files = ai_data.get("files") or []

    # Read-vs-write safety net: if the message reads as an inspection
    # question with no real change verb, drop any files the model generated
    # anyway rather than silently rewriting something the user only asked
    # to have explained. Fixed from CodeAgent's original version of this
    # check, which treated bare "karo"/"kar do" as a change-verb even when
    # it directly follows an inspection verb ("explain karo", "check karo",
    # "review karo" all mean "go ahead and look", not "make an edit") —
    # that ambiguity is harmless in CodeAgent (worst case: an unwanted
    # localStorage edit, trivially undone) but here it's a real git commit,
    # so it's worth actually distinguishing "karo" that follows an inspect
    # verb from "karo" that follows nothing / a real change verb.
    lowered_instruction = instruction.lower()
    asked_to_inspect = bool(re.search(CODEGEN_INSPECT_VERBS_RE, lowered_instruction))
    asked_for_change = bool(re.search(CODEGEN_STRONG_CHANGE_VERBS_RE, lowered_instruction))
    if not asked_for_change:
        for m in re.finditer(CODEGEN_GENERIC_DO_RE, lowered_instruction):
            preceding = lowered_instruction[:m.start()].rstrip()
            if not re.search(CODEGEN_INSPECT_VERBS_RE + r"$", preceding):
                asked_for_change = True
                break
    if asked_to_inspect and not asked_for_change:
        files = []

    if not files:
        return {"reply": reply_text, "action": "message", "source": "hybrid"}

    files = files[:MAX_CODEGEN_FILES]
    existing_set = set(existing_paths)
    file_map = {}
    skipped = []

    for f in files:
        raw_path = (f.get("path") or "").strip()
        if not raw_path:
            continue
        try:
            path = safe_repo_path(raw_path)
        except UnsafePathError:
            # AI-generated path failed validation (traversal, .github/, etc.)
            # — skip this one file rather than fail the whole multi-file
            # commit, and surface it in the same "skipped" note the user
            # already sees for snippet-match misses.
            skipped.append(f"{raw_path} (unsafe path, skip ho gaya)")
            continue
        action = f.get("action")
        if action == "create" or path not in existing_set:
            file_map[path] = f.get("content") or ""
        elif action == "edit":
            edits = f.get("edits")
            if edits:
                r = gh_api("GET", f"/repos/{owner}/{repo}/contents/{path}", gh_token)
                if r.status_code != 200:
                    skipped.append(path)
                    continue
                current = base64.b64decode(r.json()["content"]).decode("utf-8", errors="replace")
                new_content, changed, missed = apply_file_edits(current, edits)
                if changed:
                    file_map[path] = new_content
                if missed and not changed:
                    skipped.append(path)
            elif f.get("content") is not None:
                file_map[path] = f["content"]

    if not file_map:
        note = f"\n\n⚠️ In files ke edits apply nahi hue (snippet match nahi hua): {', '.join(skipped)}" if skipped else ""
        return {"reply": reply_text + note, "action": "message", "source": "hybrid"}

    n = len(file_map)
    commit_msg = f"{instruction[:60]} via Easy DevOps ({n} file{'s' if n != 1 else ''})"
    ok, err_or_empty, repo_link = commit_files_to_repo(owner, repo, gh_token, file_map, commit_msg)
    if not ok:
        return {"reply": f"❌ {err_or_empty}", "action": "error", "source": "hybrid"}

    file_list = "\n".join(f"• {p}" for p in sorted(file_map.keys()))
    skip_note = f"\n\n⚠️ Skip hui (snippet match nahi hua): {', '.join(skipped)}" if skipped else ""
    reasoning_block = f"\n\n_{reasoning}_" if reasoning else ""
    return {
        "reply": f"✅ {reply_text}{reasoning_block}\n\n**{n} file{'s' if n != 1 else ''}** → `{repo}`\n{file_list}{skip_note}\n\n🔗 {repo_link}",
        "action": "create_file", "repo": repo, "file_count": n, "source": "hybrid",
    }
