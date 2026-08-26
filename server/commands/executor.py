"""
execute_command — per-user executor.

`owner` is always the logged-in user's own GitHub login — commands never
take an arbitrary owner from the request, so there's no way to point one
user's token at another user's namespace by accident (GitHub would reject
cross-account writes anyway, but this keeps reads scoped correctly too).
"""
import re
import json
import base64
import requests

from server.providers.github import gh_api, get_file_sha
from server.providers.vercel import vc_api, vercel_find_project, vercel_find_project_by_repo, vercel_poll_deployment, vercel_project_live_url, VERCEL_TERMINAL_STATES
from server.providers.netlify import nl_api, netlify_find_site
from server.providers.render import rd_api
from server.security import safe_repo_path, UnsafePathError
from server.commands.render_blueprint import generate_render_yaml
from server.commands.render_create_service import create_render_service


def execute_command(cmd, params, owner, gh_token, vc_token=None, nl_token=None, rd_token=None):
    params = params or {}

    try:
        if cmd == "CREATE_REPO":
            repo_name = re.sub(r"[^a-zA-Z0-9_.-]", "-", params["repo"].strip())
            r = gh_api("POST", "/user/repos", gh_token, json={"name": repo_name, "private": False, "auto_init": True})
            if r.status_code == 201:
                data = r.json()
                return {"reply": f"✅ Repo ban gaya!\n**{repo_name}**\n🔗 {data['html_url']}",
                        "action": "create_repo", "url": data["html_url"], "repo": repo_name}
            elif r.status_code == 422:
                return {"reply": f"⚠️ Repo `{repo_name}` already exist karta hai.", "action": "warning"}
            else:
                return {"reply": f"❌ GitHub Error: {r.json().get('message', 'Repo nahi bana')}", "action": "error"}

        elif cmd == "DELETE_REPO":
            repo_name = params["repo"].strip()
            r = gh_api("DELETE", f"/repos/{owner}/{repo_name}", gh_token)
            if r.status_code == 204:
                return {"reply": f"🗑️ Repo `{repo_name}` delete ho gaya.", "action": "delete_repo"}
            else:
                msg = r.json().get("message", "Repo delete nahi hua") if r.content else "Repo delete nahi hua"
                if r.status_code == 403:
                    msg += " (Hint: OAuth token me `delete_repo` scope chahiye — dubara login/reconnect karke try karo.)"
                return {"reply": f"❌ Delete Error: {msg}", "action": "error"}

        elif cmd == "LIST_REPOS":
            r = gh_api("GET", f"/user/repos?per_page=20&sort=updated&affiliation=owner", gh_token)
            if r.status_code == 200:
                repos = r.json()
                if not repos:
                    return {"reply": "Koi repo nahi hai abhi.", "action": "list_repos", "repos": []}
                lines = [f"📁 **{rp['name']}** — ⭐{rp['stargazers_count']} — `{rp['visibility']}`\n🔗 {rp['html_url']}" for rp in repos]
                # Extra fields below (stars/visibility/language/fork/updated_at)
                # are only used by the frontend's compact activity-card
                # renderer — the markdown `reply` above stays the fallback
                # for older clients / the AI-narration path.
                return {"reply": f"Tere {len(repos)} repos:\n\n" + "\n\n".join(lines), "action": "list_repos",
                        "repos": [{
                            "name": rp["name"], "url": rp["html_url"],
                            "stars": rp.get("stargazers_count", 0),
                            "visibility": rp.get("visibility", "public"),
                            "language": rp.get("language"),
                            "fork": rp.get("fork", False),
                            "updated_at": rp.get("updated_at"),
                        } for rp in repos]}
            else:
                return {"reply": "❌ Repos fetch nahi hue.", "action": "error"}

        elif cmd == "LIST_FILES":
            repo = params["repo"]
            path = params.get("path", "").strip("/")
            endpoint = f"/repos/{owner}/{repo}/contents/{path}" if path else f"/repos/{owner}/{repo}/contents"
            r = gh_api("GET", endpoint, gh_token)
            if r.status_code == 200:
                items = r.json()
                if not isinstance(items, list):
                    items = [items]
                lines = [f"{'📁' if item['type'] == 'dir' else '📄'} {item['path']}" for item in items]
                reply = f"Files in `{repo}/{path or ''}`:\n\n" + "\n".join(lines)
                item_list = [{"type": item["type"], "path": item["path"], "name": item["name"]} for item in items]
                return {"reply": reply, "action": "list_files", "repo": repo, "path": path, "items": item_list}
            else:
                return {"reply": f"❌ Files fetch nahi hue: {r.json().get('message','')}", "action": "error"}

        elif cmd == "READ_FILE":
            repo, path = params["repo"], params["path"]
            r = gh_api("GET", f"/repos/{owner}/{repo}/contents/{path}", gh_token)
            if r.status_code == 200:
                file_data = r.json()
                content = base64.b64decode(file_data["content"]).decode("utf-8", errors="replace")
                return {"reply": f"📄 `{path}` ({file_data['size']} bytes):\n\n```\n{content}\n```",
                        "action": "read_file", "content": content, "sha": file_data["sha"],
                        "repo": repo, "path": path}
            else:
                return {"reply": f"❌ File nahi mili: {r.json().get('message','')}", "action": "error"}

        elif cmd == "CREATE_FILE":
            repo, content = params["repo"], params["content"]
            try:
                path = safe_repo_path(params["path"])
            except UnsafePathError as e:
                return {"reply": f"❌ Ye path allowed nahi hai: {e}", "action": "error"}
            message = params.get("message", f"Add {path} via Easy DevOps")
            content_b64 = base64.b64encode(content.encode()).decode()
            existing_sha = get_file_sha(repo, path, owner, gh_token)
            payload = {"message": message, "content": content_b64}
            if existing_sha:
                payload["sha"] = existing_sha
            r = gh_api("PUT", f"/repos/{owner}/{repo}/contents/{path}", gh_token, json=payload)
            if r.status_code in (200, 201):
                url = r.json()["content"]["html_url"]
                action = "update_file" if existing_sha else "create_file"
                verb = "Update" if existing_sha else "Bana"
                return {"reply": f"✅ File {verb} di!\n**{path}**\n🔗 {url}", "action": action, "url": url, "repo": repo}
            else:
                return {"reply": f"❌ GitHub Error: {r.json().get('message','File nahi bani')}", "action": "error"}

        elif cmd == "EDIT_FILE":
            repo, content = params["repo"], params["content"]
            try:
                path = safe_repo_path(params["path"])
            except UnsafePathError as e:
                return {"reply": f"❌ Ye path allowed nahi hai: {e}", "action": "error"}
            message = params.get("message", f"Update {path} via Easy DevOps")
            sha = get_file_sha(repo, path, owner, gh_token)
            if not sha:
                return {"reply": f"❌ File `{path}` exist nahi karti repo `{repo}` me.", "action": "error"}
            content_b64 = base64.b64encode(content.encode()).decode()
            r = gh_api("PUT", f"/repos/{owner}/{repo}/contents/{path}", gh_token,
                       json={"message": message, "content": content_b64, "sha": sha})
            if r.status_code in (200, 201):
                url = r.json()["content"]["html_url"]
                return {"reply": f"✅ File update ho gayi!\n**{path}**\n🔗 {url}", "action": "update_file", "url": url, "repo": repo}
            else:
                return {"reply": f"❌ Update Error: {r.json().get('message','')}", "action": "error"}

        elif cmd == "DELETE_FILE":
            repo = params["repo"]
            try:
                path = safe_repo_path(params["path"])
            except UnsafePathError as e:
                return {"reply": f"❌ Ye path allowed nahi hai: {e}", "action": "error"}
            message = params.get("message", f"Delete {path} via Easy DevOps")
            sha = get_file_sha(repo, path, owner, gh_token)
            if not sha:
                return {"reply": f"❌ File `{path}` exist nahi karti.", "action": "error"}
            r = gh_api("DELETE", f"/repos/{owner}/{repo}/contents/{path}", gh_token,
                       json={"message": message, "sha": sha})
            if r.status_code == 200:
                return {"reply": f"🗑️ File `{path}` delete ho gayi.", "action": "delete_file"}
            else:
                return {"reply": f"❌ Delete Error: {r.json().get('message','')}", "action": "error"}

        elif cmd == "GENERATE_RENDER_YAML":
            repo = params["repo"]
            return generate_render_yaml(repo, owner, gh_token)

        elif cmd == "GET_REPO_INFO":
            repo = params["repo"]
            r = gh_api("GET", f"/repos/{owner}/{repo}", gh_token)
            if r.status_code == 200:
                d = r.json()
                reply = (f"📁 **{d['name']}**\n"
                         f"⭐ Stars: {d['stargazers_count']} | 🍴 Forks: {d['forks_count']} | "
                         f"👁️ Watchers: {d['watchers_count']}\n"
                         f"🔓 Visibility: `{d['visibility']}`\n"
                         f"🕓 Last updated: {d['updated_at']}\n"
                         f"🔗 {d['html_url']}")
                if d.get("description"):
                    reply += f"\n📝 {d['description']}"
                return {"reply": reply, "action": "repo_info"}
            else:
                return {"reply": f"❌ Repo info fetch nahi hui: {r.json().get('message','')}", "action": "error"}

        # ──────────────── VERCEL ────────────────
        # Every Vercel branch below checks vc_token first and returns a
        # friendly "connect Vercel" prompt if missing, rather than crashing
        # on a None token — Vercel connection is optional, GitHub login is not.
        elif cmd == "VERCEL_LIST_PROJECTS":
            if not vc_token:
                return {"reply": "🔒 Pehle Vercel connect karo — user menu me 'Connect Vercel' dabao.", "action": "vercel_auth_required"}
            r = vc_api("GET", "/v9/projects", vc_token)
            if r.status_code == 200:
                projects = r.json().get("projects", [])
                if not projects:
                    return {"reply": "Koi Vercel project nahi mila.", "action": "vercel_list", "projects": []}
                # readyState of the most recent deployment maps to the
                # frontend's status badge (Live/Building/Error/etc.) — same
                # VERCEL_TERMINAL_STATES vocabulary used by
                # vercel_poll_deployment, plus the in-progress states.
                def _vercel_status(p):
                    latest = p.get("latestDeployments") or []
                    return (latest[0].get("readyState") if latest else None) or "UNKNOWN"
                lines = []
                project_cards = []
                for p in projects:
                    # Real URL from the latest deployment's alias/url — never
                    # guessed from the project name (see vercel_project_live_url
                    # docstring for why `<name>.vercel.app` can be wrong).
                    live = vercel_project_live_url(p)
                    link_line = f"\n🔗 {live}" if live else "\n_(abhi koi deployment nahi — link uplabdh nahi)_"
                    lines.append(f"▲ **{p['name']}** — `{p.get('framework') or 'static'}`{link_line}")
                    project_cards.append({
                        "name": p["name"], "id": p["id"],
                        "framework": p.get("framework"),
                        "url": live,
                        "status": _vercel_status(p),
                    })
                return {"reply": f"Tere {len(projects)} Vercel projects:\n\n" + "\n\n".join(lines),
                        "action": "vercel_list", "projects": project_cards}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Vercel token invalid ya expire ho gaya. Dubara connect karo.", "action": "vercel_auth_required"}
            else:
                return {"reply": f"❌ Vercel projects fetch nahi hue: {r.text[:200]}", "action": "error"}

        elif cmd == "VERCEL_IMPORT_REPO":
            if not vc_token:
                return {"reply": "🔒 Pehle Vercel connect karo — user menu me 'Connect Vercel' dabao.", "action": "vercel_auth_required"}
            repo = params["repo"]
            project_name = params.get("project_name") or repo
            payload = {
                "name": project_name,
                "gitRepository": {"type": "github", "repo": f"{owner}/{repo}"},
            }
            r = vc_api("POST", "/v11/projects", vc_token, json=payload)
            if r.status_code in (200, 201):
                proj = r.json()
                latest = proj.get("latestDeployments") or []
                dep_id = (latest[0].get("uid") or latest[0].get("id")) if latest else None
                reply = (f"✅ `{repo}` Vercel se connect ho gaya!\n**Project: {proj['name']}**\n"
                         f"Project ID: `{proj.get('id')}`\n\n")
                if dep_id:
                    reply += (f"⏳ Vercel ne automatically ek initial build queue kar diya hai (Deployment ID: `{dep_id}`).\n"
                              f"Status check karne ke liye bol: 'check deployment status {dep_id}'.")
                else:
                    reply += f"Build abhi queue nahi hua. Deploy trigger karne ke liye bol: 'deploy {proj['name']} to vercel'."
                return {"reply": reply, "action": "vercel_import", "project_name": proj["name"], "project_id": proj.get("id")}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Vercel token invalid ya expire ho gaya. Dubara connect karo.", "action": "vercel_auth_required"}
            else:
                err = r.json().get("error", {}).get("message", r.text[:200])
                return {"reply": f"❌ Vercel import Error: {err}", "action": "error"}

        elif cmd == "VERCEL_DEPLOY":
            if not vc_token:
                return {"reply": "🔒 Pehle Vercel connect karo — user menu me 'Connect Vercel' dabao.", "action": "vercel_auth_required"}
            project_name = params["project_name"]
            proj = vercel_find_project(project_name, vc_token)
            resolved_by_repo = False
            if not proj:
                # Exact Vercel-project-name match failed — the given name
                # is very often actually a GitHub repo name (e.g. the
                # post-upload "Deploy to Vercel" shortcut always sends the
                # repo name, and a repo/project pair can legitimately have
                # different names — see vercel_find_project_by_repo's
                # docstring). Before giving up, try resolving it as a
                # repo linked to some Vercel project instead.
                proj = vercel_find_project_by_repo(f"{owner}/{project_name}", vc_token)
                resolved_by_repo = bool(proj)
            if not proj:
                return {"reply": f"❌ Vercel project `{project_name}` nahi mila (naam se ya linked GitHub repo se). Pehle import kar, ya sahi Vercel project naam bata.", "action": "error"}
            actual_project_name = proj.get("name", project_name)

            git_repo = proj.get("link", {})
            repo_id = git_repo.get("repoId")
            git_branch = git_repo.get("productionBranch", "main")
            if not repo_id:
                return {"reply": f"❌ Project `{actual_project_name}` GitHub se linked nahi hai. Pehle import kar.", "action": "error"}

            payload = {
                "name": actual_project_name,
                "target": "production",
                "gitSource": {"type": "github", "repoId": repo_id, "ref": git_branch},
                "projectSettings": {"framework": proj.get("framework")}
            }
            r = vc_api("POST", "/v13/deployments", vc_token, json=payload)
            if r.status_code not in (200, 201):
                if r.status_code in (401, 403):
                    return {"reply": "❌ Vercel token invalid ya expire ho gaya. Dubara connect karo.", "action": "vercel_auth_required"}
                err = r.json().get("error", {}).get("message", r.text[:200])
                return {"reply": f"❌ Vercel deploy trigger Error: {err}", "action": "error"}

            dep = r.json()
            dep_id = dep.get("id")
            if not dep_id:
                return {"reply": "❌ Vercel ne deployment ID nahi diya, kuch galat hua.", "action": "error"}

            name_note = f" (repo `{project_name}` → Vercel project `{actual_project_name}`)" if resolved_by_repo and actual_project_name != project_name else ""
            result = vercel_poll_deployment(dep_id, vc_token)
            if result["ok"]:
                return {"reply": f"✅ Deployment complete!{name_note}\n**{actual_project_name}**\n🔗 {result['live_url']}\n\nID: `{dep_id}`",
                        "action": "vercel_deploy", "deployment_id": dep_id, "url": result["live_url"], "project_name": actual_project_name}
            elif result["timed_out"]:
                return {"reply": (f"⏳ Deploy trigger ho gaya hai{name_note} (ID: `{dep_id}`), lekin build abhi bhi chal raha hai.\n\n"
                                   f"Status check karne ke liye thodi der baad bol: 'check deployment status {dep_id}'."),
                        "action": "vercel_deploy_pending", "deployment_id": dep_id, "project_name": actual_project_name}
            else:
                error_detail = result["deployment"].get("errorMessage", "") or result["state"]
                return {"reply": f"❌ Deployment fail ho gaya.{name_note}\nStatus: **{result['state']}**\n{error_detail}\nID: `{dep_id}`",
                        "action": "error", "deployment_id": dep_id}

        elif cmd == "VERCEL_DELETE_PROJECT":
            if not vc_token:
                return {"reply": "🔒 Pehle Vercel connect karo — user menu me 'Connect Vercel' dabao.", "action": "vercel_auth_required"}
            project_name = params["project_name"]
            proj = vercel_find_project(project_name, vc_token)
            if not proj:
                return {"reply": f"❌ Vercel project `{project_name}` nahi mila.", "action": "error"}
            r = vc_api("DELETE", f"/v9/projects/{proj.get('id')}", vc_token)
            if r.status_code in (200, 204):
                return {"reply": f"✅ Vercel project `{project_name}` delete ho gaya.\n\n⚠️ GitHub repo abhi bhi waisa hi hai.",
                        "action": "vercel_delete_project", "project_name": project_name}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Vercel token invalid ya expire ho gaya. Dubara connect karo.", "action": "vercel_auth_required"}
            else:
                err = r.json().get("error", {}).get("message", r.text[:200]) if r.text else r.text[:200]
                return {"reply": f"❌ Vercel project delete Error: {err}", "action": "error"}

        elif cmd == "VERCEL_ROLLBACK":
            # Instant Rollback: repoints production traffic to a previous
            # READY deployment without a rebuild. `deployment_id` is
            # optional — when the caller doesn't name one, we resolve to
            # the most recent READY production deployment BEFORE the
            # current one, matching "rollback to previous version" intent.
            if not vc_token:
                return {"reply": "🔒 Pehle Vercel connect karo — user menu me 'Connect Vercel' dabao.", "action": "vercel_auth_required"}
            project_name = params["project_name"]
            proj = vercel_find_project(project_name, vc_token)
            if not proj:
                return {"reply": f"❌ Vercel project `{project_name}` nahi mila.", "action": "error"}
            project_id = proj.get("id")

            target_id = params.get("deployment_id")
            target_dep = None
            if not target_id:
                r = vc_api("GET", f"/v6/deployments?projectId={project_id}&target=production&limit=10", vc_token)
                if r.status_code not in (200,):
                    if r.status_code in (401, 403):
                        return {"reply": "❌ Vercel token invalid ya expire ho gaya. Dubara connect karo.", "action": "vercel_auth_required"}
                    return {"reply": f"❌ Deployments list nahi mili: {r.text[:200]}", "action": "error"}
                deployments = r.json().get("deployments", [])
                ready = [d for d in deployments if d.get("state") == "READY"]
                if len(ready) < 2:
                    return {"reply": f"❌ `{project_name}` ke paas rollback ke liye purani READY deployment nahi hai.", "action": "error"}
                # index 0 = current live, index 1 = previous production deploy
                target_dep = ready[1]
                target_id = target_dep.get("uid") or target_dep.get("id")

            r = vc_api("POST", f"/v1/projects/{project_id}/rollback/{target_id}", vc_token, json={})
            if r.status_code not in (200, 201, 204):
                if r.status_code in (401, 403):
                    return {"reply": "❌ Vercel token invalid ya expire ho gaya. Dubara connect karo.", "action": "vercel_auth_required"}
                err = r.json().get("error", {}).get("message", r.text[:200]) if r.text else "Rollback fail ho gaya"
                return {"reply": f"❌ Rollback Error: {err}", "action": "error"}

            created = target_dep.get("created") if target_dep else None
            when_desc = ""
            if created:
                age_min = int((time.time() * 1000 - created) / 60000)
                when_desc = f" (~{age_min} min pehle ki deployment)" if age_min < 120 else ""
            return {
                "reply": f"⏪ `{project_name}` rollback ho gaya{when_desc}!\nDeployment `{target_id}` ab live traffic serve kar rahi hai.\n\n"
                         f"Naye pushes production pe apne aap deploy nahi honge jab tak 'undo rollback' na karo (promote a new deployment).",
                "action": "vercel_rollback", "project_name": project_name, "deployment_id": target_id,
            }

        elif cmd == "VERCEL_LIST_DEPLOYMENTS":
            # Supports "which deployment to rollback to" — lists recent
            # production deployments with state + relative age so the user
            # can pick one, then say "rollback <project> to <id>".
            if not vc_token:
                return {"reply": "🔒 Pehle Vercel connect karo — user menu me 'Connect Vercel' dabao.", "action": "vercel_auth_required"}
            project_name = params["project_name"]
            proj = vercel_find_project(project_name, vc_token)
            if not proj:
                return {"reply": f"❌ Vercel project `{project_name}` nahi mila.", "action": "error"}
            r = vc_api("GET", f"/v6/deployments?projectId={proj.get('id')}&target=production&limit=10", vc_token)
            if r.status_code != 200:
                if r.status_code in (401, 403):
                    return {"reply": "❌ Vercel token invalid ya expire ho gaya. Dubara connect karo.", "action": "vercel_auth_required"}
                return {"reply": f"❌ Deployments list nahi mili: {r.text[:200]}", "action": "error"}
            deployments = r.json().get("deployments", [])
            if not deployments:
                return {"reply": f"`{project_name}` ki koi production deployment nahi mili.", "action": "vercel_deployments", "deployments": []}
            lines = []
            dep_list = []
            for d in deployments[:10]:
                dep_id = d.get("uid") or d.get("id")
                state = d.get("state", "UNKNOWN")
                created = d.get("created")
                age_min = int((time.time() * 1000 - created) / 60000) if created else None
                age_desc = f"{age_min}m pehle" if age_min is not None and age_min < 120 else (f"{age_min//60}h pehle" if age_min else "")
                icon = "🟢" if state == "READY" else ("🔴" if state == "ERROR" else "⚪")
                lines.append(f"{icon} `{dep_id}` — {state} — {age_desc}")
                dep_list.append({"id": dep_id, "state": state, "age_min": age_min})
            return {"reply": f"`{project_name}` ki recent deployments:\n\n" + "\n".join(lines) +
                             "\n\nRollback karne ke liye bol: 'rollback " + project_name + " to <id>'",
                    "action": "vercel_deployments", "project_name": project_name, "deployments": dep_list}

        elif cmd == "VERCEL_GET_ENV":
            if not vc_token:
                return {"reply": "🔒 Pehle Vercel connect karo — user menu me 'Connect Vercel' dabao.", "action": "vercel_auth_required"}
            project_name = params["project_name"]
            proj = vercel_find_project(project_name, vc_token)
            if not proj:
                return {"reply": f"❌ Vercel project `{project_name}` nahi mila.", "action": "error"}
            r = vc_api("GET", f"/v9/projects/{proj.get('id')}/env", vc_token)
            if r.status_code == 200:
                envs = r.json().get("envs", [])
                if not envs:
                    return {"reply": f"Project `{project_name}` me koi env vars nahi hai.", "action": "vercel_env"}
                lines = [f"`{e['key']}` — targets: {', '.join(e.get('target', []))}" for e in envs]
                return {"reply": f"Env vars for `{project_name}` (values encrypted, sirf keys dikha sakta hu):\n\n" + "\n".join(lines),
                        "action": "vercel_env"}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Vercel token invalid ya expire ho gaya. Dubara connect karo.", "action": "vercel_auth_required"}
            else:
                return {"reply": f"❌ Env vars fetch nahi hue: {r.text[:200]}", "action": "error"}

        elif cmd == "VERCEL_SET_ENV":
            if not vc_token:
                return {"reply": "🔒 Pehle Vercel connect karo — user menu me 'Connect Vercel' dabao.", "action": "vercel_auth_required"}
            project_name = params["project_name"]
            key = params["key"]
            value = params["value"]
            target = params.get("target", ["production", "preview", "development"])
            proj = vercel_find_project(project_name, vc_token)
            if not proj:
                return {"reply": f"❌ Vercel project `{project_name}` nahi mila.", "action": "error"}
            r = vc_api("POST", f"/v10/projects/{proj.get('id')}/env", vc_token,
                       json={"key": key, "value": value, "type": "encrypted", "target": target})
            if r.status_code in (200, 201):
                return {"reply": f"✅ Env var `{key}` set ho gaya `{project_name}` me.\n⚠️ Naya deploy trigger karo change apply karne ke liye.",
                        "action": "vercel_env_set", "project_name": project_name}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Vercel token invalid ya expire ho gaya. Dubara connect karo.", "action": "vercel_auth_required"}
            else:
                err = r.json().get("error", {}).get("message", r.text[:200])
                return {"reply": f"❌ Env set Error: {err}", "action": "error"}

        # ──────────────── NETLIFY ────────────────
        elif cmd == "NETLIFY_DEPLOY":
            # POST /sites/{id}/builds triggers a fresh production build
            # directly via the site's API-key auth — no separate build
            # hook URL to create/store first, unlike the build-hooks
            # approach in Netlify's own docs (those are meant for
            # external services with no API key of their own; this app
            # already authenticates as the user, so the plain builds
            # endpoint is the more direct path). No status polling here
            # (Vercel's deploy command polls to a terminal state) since
            # Netlify's build endpoint doesn't return a deploy object
            # with a pollable ready-state the way Vercel's does — it
            # just returns build metadata to fetch full details.
            if not nl_token:
                return {"reply": "🔒 Pehle Netlify connect karo — user menu me 'Connect Netlify' dabao.", "action": "netlify_auth_required"}
            site_name = params["site_name"]
            site = netlify_find_site(site_name, nl_token)
            if not site:
                return {"reply": f"❌ Netlify site `{site_name}` nahi mili.", "action": "error"}
            r = nl_api("POST", f"/sites/{site['id']}/builds", nl_token, json={})
            if r.status_code in (200, 201):
                build = r.json()
                return {"reply": f"✅ Deploy trigger ho gaya `{site_name}` ke liye!\nBuild ID: `{build.get('id', '')}`\n\n🔗 {site.get('url', '')}\n\nBuild Netlify dashboard pe track ho sakti hai.",
                        "action": "netlify_deploy", "site_name": site_name, "build_id": build.get("id")}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Netlify token invalid ya expire ho gaya. Dubara connect karo.", "action": "netlify_auth_required"}
            else:
                return {"reply": f"❌ Netlify deploy trigger Error: {r.text[:200]}", "action": "error"}

        elif cmd == "NETLIFY_LIST_SITES":
            if not nl_token:
                return {"reply": "🔒 Pehle Netlify connect karo — user menu me 'Connect Netlify' dabao.", "action": "netlify_auth_required"}
            r = nl_api("GET", "/sites?per_page=50", nl_token)
            if r.status_code == 200:
                sites = r.json()
                if not sites:
                    return {"reply": "Koi Netlify site nahi mili.", "action": "netlify_list", "sites": []}
                lines = [f"🌐 **{s['name']}**\n🔗 {s.get('url', '')}" for s in sites]
                return {"reply": f"Teri {len(sites)} Netlify sites:\n\n" + "\n\n".join(lines),
                        "action": "netlify_list", "sites": [{
                            "name": s["name"], "id": s["id"], "url": s.get("url", ""),
                            "status": s.get("state", "unknown"),
                        } for s in sites]}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Netlify token invalid ya expire ho gaya. Dubara connect karo.", "action": "netlify_auth_required"}
            else:
                return {"reply": f"❌ Netlify sites fetch nahi hui: {r.text[:200]}", "action": "error"}

        elif cmd == "NETLIFY_GET_SITE_INFO":
            if not nl_token:
                return {"reply": "🔒 Pehle Netlify connect karo — user menu me 'Connect Netlify' dabao.", "action": "netlify_auth_required"}
            site_name = params["site_name"]
            site = netlify_find_site(site_name, nl_token)
            if not site:
                return {"reply": f"❌ Netlify site `{site_name}` nahi mili.", "action": "error"}
            reply = (f"🌐 **{site['name']}**\n"
                     f"🔗 {site.get('url', '')}\n"
                     f"🆔 `{site['id']}`\n"
                     f"🕓 Last updated: {site.get('updated_at', '')}")
            if site.get("custom_domain"):
                reply += f"\n🌍 Custom domain: {site['custom_domain']}"
            return {"reply": reply, "action": "netlify_site_info"}

        elif cmd == "NETLIFY_DELETE_SITE":
            if not nl_token:
                return {"reply": "🔒 Pehle Netlify connect karo — user menu me 'Connect Netlify' dabao.", "action": "netlify_auth_required"}
            site_name = params["site_name"]
            site = netlify_find_site(site_name, nl_token)
            if not site:
                return {"reply": f"❌ Netlify site `{site_name}` nahi mili.", "action": "error"}
            r = nl_api("DELETE", f"/sites/{site['id']}", nl_token)
            if r.status_code in (200, 204):
                return {"reply": f"🗑️ Netlify site `{site_name}` delete ho gayi.", "action": "netlify_delete_site"}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Netlify token invalid ya expire ho gaya. Dubara connect karo.", "action": "netlify_auth_required"}
            else:
                return {"reply": f"❌ Site delete Error: {r.text[:200]}", "action": "error"}

        elif cmd == "NETLIFY_GET_ENV":
            if not nl_token:
                return {"reply": "🔒 Pehle Netlify connect karo — user menu me 'Connect Netlify' dabao.", "action": "netlify_auth_required"}
            site_name = params["site_name"]
            site = netlify_find_site(site_name, nl_token)
            if not site:
                return {"reply": f"❌ Netlify site `{site_name}` nahi mili.", "action": "error"}
            account_id = site.get("account_id")
            if not account_id:
                return {"reply": "❌ Is site ka account_id nahi mila.", "action": "error"}
            r = nl_api("GET", f"/accounts/{account_id}/env?site_id={site['id']}", nl_token)
            if r.status_code == 200:
                envs = r.json()
                if not envs:
                    return {"reply": f"Site `{site_name}` me koi env vars nahi hai.", "action": "netlify_env"}
                lines = [f"`{e['key']}`" for e in envs]
                return {"reply": f"Env vars for `{site_name}` (values encrypted, sirf keys dikha sakta hu):\n\n" + "\n".join(lines),
                        "action": "netlify_env"}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Netlify token invalid ya expire ho gaya. Dubara connect karo.", "action": "netlify_auth_required"}
            else:
                return {"reply": f"❌ Env vars fetch nahi hue: {r.text[:200]}", "action": "error"}

        elif cmd == "NETLIFY_SET_ENV":
            if not nl_token:
                return {"reply": "🔒 Pehle Netlify connect karo — user menu me 'Connect Netlify' dabao.", "action": "netlify_auth_required"}
            site_name = params["site_name"]
            key = params["key"]
            value = params["value"]
            site = netlify_find_site(site_name, nl_token)
            if not site:
                return {"reply": f"❌ Netlify site `{site_name}` nahi mili.", "action": "error"}
            account_id = site.get("account_id")
            if not account_id:
                return {"reply": "❌ Is site ka account_id nahi mila.", "action": "error"}
            payload = {
                "key": key,
                "scopes": ["builds", "functions", "runtime", "post_processing"],
                "values": [{"value": value, "context": "all"}],
            }
            r = nl_api("POST", f"/accounts/{account_id}/env?site_id={site['id']}", nl_token, json=payload)
            if r.status_code in (200, 201):
                return {"reply": f"✅ Env var `{key}` set ho gaya `{site_name}` me.\n⚠️ Naya deploy trigger karo change apply karne ke liye.",
                        "action": "netlify_env_set", "site_name": site_name}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Netlify token invalid ya expire ho gaya. Dubara connect karo.", "action": "netlify_auth_required"}
            else:
                return {"reply": f"❌ Env set Error: {r.text[:200]}", "action": "error"}

        # ──────────────── RENDER ────────────────
        elif cmd == "RENDER_CREATE_SERVICE":
            if not rd_token:
                return {"reply": "🔒 Pehle Render connect karo — user menu me 'Connect Render' dabao.", "action": "render_auth_required"}
            repo = params["repo"]
            plan = params.get("plan")
            branch = params.get("branch")
            region = params.get("region")
            return create_render_service(repo, owner, gh_token, rd_token, plan=plan, branch=branch, region=region)

        elif cmd == "RENDER_LIST_SERVICES":
            if not rd_token:
                return {"reply": "🔒 Pehle Render connect karo — user menu me 'Connect Render' dabao.", "action": "render_auth_required"}
            r = rd_api("GET", "/services?limit=50", rd_token)
            if r.status_code == 200:
                items = r.json()
                if not items:
                    return {"reply": "Koi Render service nahi mila.", "action": "render_list", "services": []}
                lines = []
                services = []
                for item in items:
                    svc = item.get("service", item)
                    name = svc.get("name", "unknown")
                    stype = svc.get("type", "service")
                    sid = svc.get("id", "")
                    url = svc.get("serviceDetails", {}).get("url", "")
                    # Render's REST API doesn't return a simple ready/building
                    # enum on the service object itself (that lives on
                    # individual deploys) — "suspended" is the one reliable
                    # top-level signal available here without an extra call
                    # per service. The frontend treats missing/unknown status
                    # as neutral rather than assuming healthy.
                    suspended = svc.get("suspended") == "suspended"
                    icon = {"web_service": "🌐", "static_site": "📦", "private_service": "🔒",
                            "background_worker": "⚙️", "cron_job": "⏰", "postgres": "🐘", "redis": "🟥"}.get(stype, "🧩")
                    line = f"{icon} **{name}** — `{stype}`\nID: `{sid}`"
                    if url:
                        line += f"\n🔗 {url}"
                    lines.append(line)
                    services.append({
                        "name": name, "id": sid, "type": stype, "url": url,
                        "status": "suspended" if suspended else "active",
                    })
                return {"reply": f"Tere {len(items)} Render services:\n\n" + "\n\n".join(lines),
                        "action": "render_list", "services": services}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Render token invalid ya expire ho gaya. Dubara connect karo.", "action": "render_auth_required"}
            else:
                return {"reply": f"❌ Render services fetch nahi hue: {r.text[:200]}", "action": "error"}

        elif cmd == "RENDER_GET_ENV":
            if not rd_token:
                return {"reply": "🔒 Pehle Render connect karo — user menu me 'Connect Render' dabao.", "action": "render_auth_required"}
            service_id = params["service_id"]
            r = rd_api("GET", f"/services/{service_id}/env-vars?limit=100", rd_token)
            if r.status_code == 200:
                items = r.json()
                if not items:
                    return {"reply": f"Service `{service_id}` me koi env vars nahi hai.", "action": "render_env"}
                lines = [f"`{item['envVar']['key']}` = `{item['envVar']['value']}`" for item in items]
                return {"reply": f"Env vars for `{service_id}`:\n\n" + "\n".join(lines), "action": "render_env"}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Render token invalid ya expire ho gaya. Dubara connect karo.", "action": "render_auth_required"}
            else:
                return {"reply": f"❌ Env vars fetch nahi hue: {r.text[:200]}", "action": "error"}

        elif cmd == "RENDER_SET_ENV":
            if not rd_token:
                return {"reply": "🔒 Pehle Render connect karo — user menu me 'Connect Render' dabao.", "action": "render_auth_required"}
            service_id = params["service_id"]
            new_vars = params["env_vars"]

            existing_r = rd_api("GET", f"/services/{service_id}/env-vars?limit=100", rd_token)
            existing = {}
            if existing_r.status_code == 200:
                for item in existing_r.json():
                    existing[item["envVar"]["key"]] = item["envVar"]["value"]
            elif existing_r.status_code in (401, 403):
                return {"reply": "❌ Render token invalid ya expire ho gaya. Dubara connect karo.", "action": "render_auth_required"}

            existing.update(new_vars)
            payload = [{"key": k, "value": v} for k, v in existing.items()]

            r = rd_api("PUT", f"/services/{service_id}/env-vars", rd_token, json=payload)
            if r.status_code in (200, 201):
                keys = ", ".join(new_vars.keys())
                return {"reply": f"✅ Env vars update ho gaye for `{service_id}`!\nUpdated keys: `{keys}`\n\n⚠️ Service redeploy hoga automatically Render ki taraf se.",
                        "action": "render_env_update", "service_id": service_id}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Render token invalid ya expire ho gaya. Dubara connect karo.", "action": "render_auth_required"}
            else:
                return {"reply": f"❌ Env update Error: {r.text[:200]}", "action": "error"}

        elif cmd == "RENDER_DEPLOY":
            if not rd_token:
                return {"reply": "🔒 Pehle Render connect karo — user menu me 'Connect Render' dabao.", "action": "render_auth_required"}
            service_id = params["service_id"]
            clear_cache = params.get("clear_cache", False)
            payload = {"clearCache": "clear" if clear_cache else "do_not_clear"}
            r = rd_api("POST", f"/services/{service_id}/deploys", rd_token, json=payload)
            if r.status_code in (200, 201):
                dep = r.json()
                dep_id = dep.get("id", "")
                status = dep.get("status", "queued")
                cache_note = "(cache cleared)" if clear_cache else ""
                return {"reply": f"🚀 Deploy trigger ho gaya for `{service_id}` {cache_note}\nDeploy ID: `{dep_id}`\nStatus: **{status}**",
                        "action": "render_deploy", "deploy_id": dep_id, "status": status}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Render token invalid ya expire ho gaya. Dubara connect karo.", "action": "render_auth_required"}
            else:
                return {"reply": f"❌ Render deploy Error: {r.text[:200]}", "action": "error"}

        elif cmd == "RENDER_DELETE_SERVICE":
            if not rd_token:
                return {"reply": "🔒 Pehle Render connect karo — user menu me 'Connect Render' dabao.", "action": "render_auth_required"}
            service_id = params["service_id"]
            r = rd_api("DELETE", f"/services/{service_id}", rd_token)
            if r.status_code in (200, 204):
                return {"reply": f"🗑️ Render service `{service_id}` delete ho gaya.", "action": "render_delete_service"}
            elif r.status_code in (401, 403):
                return {"reply": "❌ Render token invalid ya expire ho gaya. Dubara connect karo.", "action": "render_auth_required"}
            else:
                return {"reply": f"❌ Service delete Error: {r.text[:200]}", "action": "error"}

        else:
            return {"reply": f"❌ Unknown command: {cmd}", "action": "error"}

    except KeyError as e:
        return {"reply": f"❌ Required field missing: {str(e)}. Dobara try kar zyada detail ke saath.", "action": "error"}
    except requests.Timeout:
        return {"reply": "❌ Request timeout ho gaya. Dobara try karo 🔄", "action": "error"}
    except Exception as e:
        return {"reply": f"❌ Error: {str(e)}", "action": "error"}

