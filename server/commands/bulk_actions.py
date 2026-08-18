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
                   json={"message": f"Bulk delete {path} via DevOps Agent", "sha": sha})
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
