"""
RENDER_CREATE_SERVICE — creates a brand-new Render web service pointed at
one of the user's already-connected GitHub repos, filling in build/start
commands automatically via the same stack-detection logic GENERATE_RENDER_YAML
uses (server.commands.render_blueprint.detect_stack), so a fresher doesn't
have to know Render's dashboard fields to get a working service.

Render's Create Service API (POST /v1/services) requires an `ownerId`
(workspace ID) that nothing else in this app currently stores anywhere —
every other Render command operates on an existing service_id and never
needed it. Rather than add a new field to the user's DB row (another thing
to keep in sync / re-fetch if it changes), it's looked up fresh via
GET /v1/owners each time: cheap, always current, and this command is not
high-frequency enough for the extra round-trip to matter.

Everything here fails soft with a Hinglish reply + "error" action, matching
the pattern used throughout executor.py, so a bad plan name / duplicate
service name / bad repo etc. reads as a normal chat error bubble instead of
a raw exception.
"""
from server.providers.github import gh_api
from server.providers.render import rd_api
from server.commands.render_blueprint import detect_stack

# Render's documented plan identifiers for web services (paid Starter and
# up require billing info on the workspace — Render's own API returns a
# clear 402 in that case, which _create_service surfaces as-is rather than
# guessing at the reason).
VALID_PLANS = {"free", "starter", "standard", "pro", "pro_plus", "pro_max", "pro_ultra"}
DEFAULT_PLAN = "free"

VALID_REGIONS = {"oregon", "ohio", "virginia", "frankfurt", "singapore"}
DEFAULT_REGION = "oregon"


def _stack_env_details(stack, pkg_json, has_app_py):
    """Returns (runtime, buildCommand, startCommand) for the detected stack —
    same command choices as render_blueprint.py's per-stack builders, kept
    in sync manually since the two live in slightly different response
    shapes (flat render.yaml keys there vs Render API's nested
    envSpecificDetails here) and merging them isn't worth the indirection
    for four short if-branches."""
    if stack == "python":
        start = "gunicorn app:app" if has_app_py else "python main.py"
        return "python", "pip install -r requirements.txt", start
    if stack == "node":
        scripts = (pkg_json or {}).get("scripts", {}) if isinstance(pkg_json, dict) else {}
        start_cmd = "npm start" if "start" in scripts else "node index.js"
        build_cmd = "npm install && npm run build" if "build" in scripts else "npm install"
        return "node", build_cmd, start_cmd
    if stack == "go":
        return "go", "go build -o app .", "./app"
    if stack == "ruby":
        return "ruby", "bundle install", "bundle exec ruby app.rb"
    # docker — Render builds from the Dockerfile directly, no build/start
    # command pair to supply.
    return "docker", None, None


def _get_owner_id(rd_token):
    """First workspace on the account. Render API keys can belong to more
    than one workspace (personal + team workspaces) — for EasyDevOps'
    single-user-connecting-their-own-account flow the first one returned
    is the right default in the overwhelming majority of cases, same
    assumption the rest of this app already makes about "the" GitHub/
    Vercel account being unambiguous once connected."""
    r = rd_api("GET", "/owners?limit=20", rd_token)
    if r.status_code != 200:
        return None, r
    owners = r.json()
    if not owners:
        return None, r
    return owners[0]["owner"]["id"], r


def create_render_service(repo, owner, gh_token, rd_token, plan=None, branch=None, region=None):
    """Detects the repo's stack, resolves the Render workspace, and creates
    a new web service via POST /v1/services. Returns an execute_command-
    shaped result dict (reply/action/…)."""
    if not rd_token:
        return {"reply": "🔒 Pehle Render connect karo — user menu me 'Connect Render' dabao.", "action": "render_auth_required"}

    plan = (plan or DEFAULT_PLAN).strip().lower()
    if plan not in VALID_PLANS:
        return {"reply": f"❌ Plan `{plan}` valid nahi hai. Options: {', '.join(sorted(VALID_PLANS))}.", "action": "error"}

    region = (region or DEFAULT_REGION).strip().lower()
    if region not in VALID_REGIONS:
        return {"reply": f"❌ Region `{region}` valid nahi hai. Options: {', '.join(sorted(VALID_REGIONS))}.", "action": "error"}

    repo_r = gh_api("GET", f"/repos/{owner}/{repo}", gh_token)
    if repo_r.status_code != 200:
        msg = repo_r.json().get("message", "Repo nahi mila") if repo_r.content else "Repo nahi mila"
        return {"reply": f"❌ GitHub: {msg}", "action": "error"}
    repo_data = repo_r.json()
    repo_url = repo_data.get("html_url")
    default_branch = repo_data.get("default_branch", "main")
    use_branch = (branch or default_branch).strip()

    root_r = gh_api("GET", f"/repos/{owner}/{repo}/contents/", gh_token)
    if root_r.status_code != 200:
        msg = root_r.json().get("message", "Repo root read nahi hui") if root_r.content else "Repo root read nahi hui"
        return {"reply": f"❌ GitHub: {msg}", "action": "error"}
    root_entries = root_r.json()
    root_names = [e["name"] for e in root_entries if e.get("type") == "file"]

    stack = detect_stack(root_names)
    if not stack:
        return {
            "reply": ("⚠️ Stack detect nahi hui — root me koi jaana-pehchana marker file "
                       "(requirements.txt, package.json, go.mod, Gemfile, Dockerfile) nahi mili. "
                       "Render service manually banana padega dashboard se."),
            "action": "warning",
        }

    pkg_json = None
    if stack == "node":
        import base64, json
        pkg_r = gh_api("GET", f"/repos/{owner}/{repo}/contents/package.json", gh_token)
        if pkg_r.status_code == 200:
            try:
                pkg_json = json.loads(base64.b64decode(pkg_r.json()["content"]))
            except Exception:
                pkg_json = None
    has_app_py = "app.py" in root_names

    runtime, build_cmd, start_cmd = _stack_env_details(stack, pkg_json, has_app_py)

    owner_id, owners_r = _get_owner_id(rd_token)
    if owner_id is None:
        if owners_r.status_code in (401, 403):
            return {"reply": "❌ Render token invalid ya expire ho gaya. Dubara connect karo.", "action": "render_auth_required"}
        return {"reply": f"❌ Render workspace fetch nahi hua: {owners_r.text[:200]}", "action": "error"}

    service_details = {"region": region, "plan": plan, "runtime": runtime}
    if build_cmd is not None or start_cmd is not None:
        env_specific = {}
        if build_cmd is not None:
            env_specific["buildCommand"] = build_cmd
        if start_cmd is not None:
            env_specific["startCommand"] = start_cmd
        service_details["envSpecificDetails"] = env_specific

    payload = {
        "type": "web_service",
        "name": repo,
        "ownerId": owner_id,
        "repo": repo_url,
        "branch": use_branch,
        "autoDeploy": "yes",
        "serviceDetails": service_details,
    }

    r = rd_api("POST", "/services", rd_token, json=payload)
    if r.status_code == 201:
        data = r.json()
        svc = data.get("service", data)
        sid = svc.get("id", "")
        svc_url = svc.get("serviceDetails", {}).get("url", "")
        stack_label = {"python": "Python", "node": "Node.js", "go": "Go", "ruby": "Ruby", "docker": "Dockerfile"}[stack]
        cmd_note = f"\nBuild: `{build_cmd}`\nStart: `{start_cmd}`" if build_cmd else "\nDockerfile se build hogi."
        url_note = f"\n🔗 {svc_url}" if svc_url else ""
        return {
            "reply": (f"✅ Render web service ban gayi!\n**{repo}** ({stack_label} detect hui, `{plan}` plan, `{region}`)\n"
                      f"ID: `{sid}`{cmd_note}{url_note}\n\n"
                      f"⚠️ Pehli deploy automatically shuru ho jayegi — build/start command check kar lena agar apka setup standard se hatke hai."),
            "action": "render_create_service", "service_id": sid, "repo": repo,
        }
    elif r.status_code in (401, 403):
        return {"reply": "❌ Render token invalid ya expire ho gaya. Dubara connect karo.", "action": "render_auth_required"}
    elif r.status_code == 402:
        return {"reply": f"❌ Ye plan (`{plan}`) ke liye Render workspace me billing info chahiye. Free plan try karo ya Render dashboard me card add karo.", "action": "error"}
    elif r.status_code == 409:
        return {"reply": f"❌ Render me `{repo}` naam ki service already exist karti hai. Alag naam try karo dashboard se, ya existing service ko hi deploy karo.", "action": "error"}
    else:
        err_msg = "Service create nahi hui"
        try:
            err_msg = r.json().get("message", err_msg)
        except Exception:
            pass
        return {"reply": f"❌ Render Error: {err_msg}", "action": "error"}
