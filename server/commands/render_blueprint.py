"""
GENERATE_RENDER_YAML — inspects a repo's root-level files (via GitHub's
contents API, no clone needed) and generates a render.yaml Infrastructure-
as-Code blueprint (Render's documented format: https://render.com/docs/blueprint-spec),
then commits it to the repo root through the same GitHub contents PUT flow
every other file-write command uses (get_file_sha -> PUT with sha if it
already exists).

Detection is intentionally simple, framework-signature based — no code
execution, just "which marker files exist at repo root" (package.json,
requirements.txt, go.mod, etc.). Good enough to get a working starting
point; the reply always tells the user to review the committed file
before deploying, since a generated blueprint can't know things like a
custom build command or a non-standard start script.
"""
import json
import base64

from server.providers.github import gh_api, get_file_sha
from server.security import safe_repo_path, UnsafePathError


# Each entry: (marker filename at repo root, service builder). The list is
# checked in order and the FIRST match wins — ordering therefore matters
# where stacks could plausibly co-exist in one repo (e.g. a Python repo
# that also ships a package.json for frontend tooling): more specific /
# more likely-to-be-the-actual-app markers are listed first.
def _detect_stack(root_names):
    if "requirements.txt" in root_names or "Pipfile" in root_names or "pyproject.toml" in root_names:
        return "python"
    if "go.mod" in root_names:
        return "go"
    if "Gemfile" in root_names:
        return "ruby"
    if "package.json" in root_names:
        return "node"
    if any(n.lower() == "dockerfile" for n in root_names):
        return "docker"
    return None


def _python_service(repo, has_flask_app_py):
    start = "gunicorn app:app" if has_flask_app_py else "python main.py"
    return {
        "type": "web",
        "name": repo,
        "runtime": "python",
        "buildCommand": "pip install -r requirements.txt",
        "startCommand": start,
        "envVars": [{"key": "PYTHON_VERSION", "value": "3.11.0"}],
    }


def _node_service(repo, pkg_json):
    scripts = (pkg_json or {}).get("scripts", {}) if isinstance(pkg_json, dict) else {}
    start_cmd = "npm start" if "start" in scripts else "node index.js"
    build_cmd = "npm install"
    if "build" in scripts:
        build_cmd = "npm install && npm run build"
    return {
        "type": "web",
        "name": repo,
        "runtime": "node",
        "buildCommand": build_cmd,
        "startCommand": start_cmd,
    }


def _go_service(repo):
    return {
        "type": "web",
        "name": repo,
        "runtime": "go",
        "buildCommand": "go build -o app .",
        "startCommand": "./app",
    }


def _ruby_service(repo):
    return {
        "type": "web",
        "name": repo,
        "runtime": "ruby",
        "buildCommand": "bundle install",
        "startCommand": "bundle exec ruby app.rb",
    }


def _docker_service(repo):
    return {
        "type": "web",
        "name": repo,
        "runtime": "docker",
        "dockerfilePath": "./Dockerfile",
    }


def _to_yaml(blueprint):
    """Hand-rolled minimal YAML emitter — the blueprint shape here is
    always a flat services-list-of-dicts, so a real YAML library is
    overkill and this avoids adding a new dependency for one command.
    Every value that needs it is quoted defensively."""
    def scalar(v):
        if isinstance(v, bool):
            return "true" if v else "false"
        s = str(v)
        if s == "" or any(c in s for c in ":#{}[]&*!|>'\"%@`,") or s != s.strip():
            return json.dumps(s)
        return s

    lines = ["services:"]
    for svc in blueprint["services"]:
        first = True
        for key, val in svc.items():
            prefix = "  - " if first else "    "
            first = False
            if key == "envVars" and isinstance(val, list):
                if not val:
                    continue
                lines.append(f"{prefix}envVars:")
                for ev in val:
                    lines.append(f"      - key: {scalar(ev['key'])}")
                    if "value" in ev:
                        lines.append(f"        value: {scalar(ev['value'])}")
                    elif "sync" in ev:
                        lines.append(f"        sync: {scalar(ev['sync'])}")
                continue
            lines.append(f"{prefix}{key}: {scalar(val)}")
    return "\n".join(lines) + "\n"


def generate_render_yaml(repo, owner, gh_token):
    """Fetches repo root contents, detects the stack, builds a render.yaml
    blueprint, commits it (create or update), returns an execute_command-
    shaped result dict."""
    root_r = gh_api("GET", f"/repos/{owner}/{repo}/contents/", gh_token)
    if root_r.status_code != 200:
        msg = root_r.json().get("message", "Repo root read nahi hui") if root_r.content else "Repo root read nahi hui"
        return {"reply": f"❌ GitHub: {msg}", "action": "error"}

    root_entries = root_r.json()
    root_names = [e["name"] for e in root_entries if e.get("type") == "file"]

    stack = _detect_stack(root_names)
    if not stack:
        return {
            "reply": ("⚠️ Stack detect nahi hui — root me koi jaana-pehchana marker file "
                       "(requirements.txt, package.json, go.mod, Gemfile, Dockerfile) nahi mili. "
                       "render.yaml manually banana padega."),
            "action": "warning",
        }

    if stack == "python":
        has_app_py = "app.py" in root_names
        service = _python_service(repo, has_app_py)
    elif stack == "node":
        pkg_json = None
        pkg_r = gh_api("GET", f"/repos/{owner}/{repo}/contents/package.json", gh_token)
        if pkg_r.status_code == 200:
            try:
                raw = base64.b64decode(pkg_r.json()["content"])
                pkg_json = json.loads(raw)
            except Exception:
                pkg_json = None
        service = _node_service(repo, pkg_json)
    elif stack == "go":
        service = _go_service(repo)
    elif stack == "ruby":
        service = _ruby_service(repo)
    else:  # docker
        service = _docker_service(repo)

    blueprint = {"services": [service]}
    yaml_content = _to_yaml(blueprint)

    try:
        path = safe_repo_path("render.yaml")
    except UnsafePathError as e:
        return {"reply": f"❌ Path allowed nahi hai: {e}", "action": "error"}

    existing_sha = get_file_sha(repo, path, owner, gh_token)
    content_b64 = base64.b64encode(yaml_content.encode()).decode()
    message = ("Regenerate render.yaml via Easy DevOps" if existing_sha
               else "Add render.yaml (auto-generated) via Easy DevOps")
    payload = {"message": message, "content": content_b64}
    if existing_sha:
        payload["sha"] = existing_sha

    r = gh_api("PUT", f"/repos/{owner}/{repo}/contents/{path}", gh_token, json=payload)
    if r.status_code not in (200, 201):
        err = r.json().get("message", "render.yaml commit nahi hua") if r.content else "render.yaml commit nahi hua"
        return {"reply": f"❌ GitHub Error: {err}", "action": "error"}

    url = r.json()["content"]["html_url"]
    verb = "Update" if existing_sha else "Bana"
    stack_label = {"python": "Python", "node": "Node.js", "go": "Go", "ruby": "Ruby", "docker": "Dockerfile"}[stack]
    return {
        "reply": (f"✅ render.yaml {verb} di! ({stack_label} stack detect hui)\n"
                  f"**{path}**\n🔗 {url}\n\n"
                  f"⚠️ Ek baar file check kar lena — build/start command apne repo ke hisaab se "
                  f"adjust karne padh sakte hain deploy karne se pehle."),
        "action": "update_file" if existing_sha else "create_file",
        "url": url, "repo": repo,
    }
