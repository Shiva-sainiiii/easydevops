"""
BULK ACTIONS — multi-select operations from the file-list / repo-list /
Vercel-list UI ("select several rows, then delete/toggle-visibility all
of them"). Deliberately a separate module from executor.py's single-item
commands: the frontend already has a structured list of targets (paths,
repo names, project ids) picked via checkboxes, not a natural-language
sentence to regex-match — so these are reached through their own
/api/bulk-action route rather than being shoehorned into the intent
parser.

Every bulk op:
  - goes through the SAME confirm-token gate as single-item destructive
    commands (see server/commands/confirmation.py) — bulk delete is not
    exempt from confirmation just because it's a new code path.
  - is partial-failure tolerant: one item failing (already deleted,
    permission error, etc.) doesn't abort the rest — the reply reports
    a per-item breakdown so the user can see exactly what happened.
"""
from server.providers.github import gh_api, get_file_sha
from server.providers.vercel import vc_api, vercel_find_project
from server.providers.netlify import nl_api, netlify_find_site
from server.providers.render import rd_api
from server.security import safe_repo_path, UnsafePathError

MAX_BULK_ITEMS = 50  # sanity cap — a fat-fingered "select all" on a huge list shouldn't fire 500 API calls


def _cap(items):
    return items[:MAX_BULK_ITEMS]


def bulk_delete_files(repo, paths, owner, gh_token):
    paths = _cap(paths)
    ok, failed = [], []
    for raw_path in paths:
        try:
            path = safe_repo_path(raw_path)
        except UnsafePathError:
            failed.append((raw_path, "path allowed nahi hai"))
            continue
        sha = get_file_sha(repo, path, owner, gh_token)
        if not sha:
            failed.append((path, "exist nahi karti"))
            continue
        r = gh_api("DELETE", f"/repos/{owner}/{repo}/contents/{path}", gh_token,
                   json={"message": f"Bulk delete {path} via Easy DevOps", "sha": sha})
        if r.status_code == 200:
            ok.append(path)
        else:
            msg = r.json().get("message", "delete fail") if r.content else "delete fail"
            failed.append((path, msg))

    return _bulk_reply(
        action="bulk_delete_files",
        ok_count=len(ok), fail_count=len(failed),
        ok_label=f"{len(ok)} file{'s' if len(ok) != 1 else ''} delete ho gayi" + ("n" if len(ok) != 1 else ""),
        failed=failed, extra={"repo": repo, "deleted_paths": ok},
    )


def bulk_delete_repos(repo_names, owner, gh_token):
    repo_names = _cap(repo_names)
    ok, failed = [], []
    for name in repo_names:
        r = gh_api("DELETE", f"/repos/{owner}/{name}", gh_token)
        if r.status_code == 204:
            ok.append(name)
        else:
            msg = r.json().get("message", "delete fail") if r.content else "delete fail"
            if r.status_code == 403:
                msg += " (delete_repo scope chahiye)"
            failed.append((name, msg))

    return _bulk_reply(
        action="bulk_delete_repos",
        ok_count=len(ok), fail_count=len(failed),
        ok_label=f"{len(ok)} repo{'s' if len(ok) != 1 else ''} delete ho gaye" if len(ok) != 1 else "1 repo delete ho gaya",
        failed=failed, extra={"deleted_repos": ok},
    )


def bulk_set_repo_visibility(repo_names, make_private, owner, gh_token):
    repo_names = _cap(repo_names)
    ok, failed = [], []
    for name in repo_names:
        r = gh_api("PATCH", f"/repos/{owner}/{name}", gh_token, json={"private": bool(make_private)})
        if r.status_code == 200:
            ok.append(name)
        else:
            msg = r.json().get("message", "update fail") if r.content else "update fail"
            failed.append((name, msg))

    label = "private" if make_private else "public"
    return _bulk_reply(
        action="bulk_set_repo_visibility",
        ok_count=len(ok), fail_count=len(failed),
        ok_label=f"{len(ok)} repo{'s' if len(ok) != 1 else ''} ab {label} hai" + ("n" if len(ok) != 1 else ""),
        failed=failed, extra={"updated_repos": ok, "visibility": label},
    )


def bulk_delete_vercel_projects(project_names, vc_token):
    project_names = _cap(project_names)
    ok, failed = [], []
    for name in project_names:
        proj = vercel_find_project(name, vc_token)
        if not proj:
            failed.append((name, "nahi mila"))
            continue
        r = vc_api("DELETE", f"/v9/projects/{proj.get('id')}", vc_token)
        if r.status_code in (200, 204):
            ok.append(name)
        else:
            err = r.json().get("error", {}).get("message", "delete fail") if r.text else "delete fail"
            failed.append((name, err))

    return _bulk_reply(
        action="bulk_delete_vercel_projects",
        ok_count=len(ok), fail_count=len(failed),
        ok_label=f"{len(ok)} Vercel project{'s' if len(ok) != 1 else ''} delete ho gaye" if len(ok) != 1 else "1 Vercel project delete ho gaya",
        failed=failed, extra={"deleted_projects": ok},
    )


def bulk_delete_netlify_sites(site_names, nl_token):
    """Takes site names/subdomains (same identifier the Netlify list UI
    shows and checkboxes select by), resolved to a site object first —
    same pattern as bulk_delete_vercel_projects, since Netlify's delete
    endpoint wants a site_id and name/subdomain isn't guaranteed to be one."""
    site_names = _cap(site_names)
    ok, failed = [], []
    for name in site_names:
        site = netlify_find_site(name, nl_token)
        if not site:
            failed.append((name, "nahi mila"))
            continue
        r = nl_api("DELETE", f"/sites/{site['id']}", nl_token)
        if r.status_code in (200, 204):
            ok.append(name)
        else:
            err = r.json().get("message", "delete fail") if r.content else "delete fail"
            failed.append((name, err))

    return _bulk_reply(
        action="bulk_delete_netlify_sites",
        ok_count=len(ok), fail_count=len(failed),
        ok_label=f"{len(ok)} Netlify site{'s' if len(ok) != 1 else ''} delete ho gayi" if len(ok) != 1 else "1 Netlify site delete ho gayi",
        failed=failed, extra={"deleted_sites": ok},
    )


def bulk_delete_render_services(service_ids, rd_token):
    """Takes service IDs directly (srv-xxxxx), NOT names — unlike GitHub
    repos / Vercel projects / Netlify sites, every Render command in this
    app (RENDER_DELETE_SERVICE, RENDER_GET_ENV, RENDER_DEPLOY, ...) already
    operates on the raw service_id with no name-based lookup step, since
    the list UI surfaces the id directly and there's no Render "find by
    name" endpoint to resolve through. Kept consistent with that rather
    than introducing a name-lookup path that doesn't exist elsewhere."""
    service_ids = _cap(service_ids)
    ok, failed = [], []
    for sid in service_ids:
        r = rd_api("DELETE", f"/services/{sid}", rd_token)
        if r.status_code in (200, 204):
            ok.append(sid)
        else:
            msg = r.json().get("message", "delete fail") if r.content else "delete fail"
            failed.append((sid, msg))

    return _bulk_reply(
        action="bulk_delete_render_services",
        ok_count=len(ok), fail_count=len(failed),
        ok_label=f"{len(ok)} Render service{'s' if len(ok) != 1 else ''} delete ho gayi" if len(ok) != 1 else "1 Render service delete ho gayi",
        failed=failed, extra={"deleted_services": ok},
    )


def _bulk_reply(action, ok_count, fail_count, ok_label, failed, extra):
    lines = []
    if ok_count:
        lines.append(f"✅ {ok_label}.")
    if failed:
        lines.append(f"⚠️ {fail_count} fail ho gaye:")
        for name, reason in failed[:15]:  # cap the listed failures too, keeps the reply readable
            lines.append(f"  • `{name}` — {reason}")
        if len(failed) > 15:
            lines.append(f"  …aur {len(failed) - 15} aur.")
    if not ok_count and not failed:
        lines.append("Kuch select nahi kiya gaya.")

    result = {"reply": "\n".join(lines), "action": action, "ok_count": ok_count, "fail_count": fail_count}
    result.update(extra)
    return result
