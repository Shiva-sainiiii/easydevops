"""Vercel API wrapper + project/deployment helpers."""
import time
import requests


def vc_api(method, endpoint, vc_token, **kwargs):
    url = f"https://api.vercel.com{endpoint}"
    headers = {
        "Authorization": f"Bearer {vc_token}",
        "Content-Type": "application/json",
    }
    return requests.request(method, url, headers=headers, timeout=20, **kwargs)


def vercel_find_project(project_name, vc_token):
    r = vc_api("GET", "/v9/projects", vc_token)
    if r.status_code != 200:
        return None
    for p in r.json().get("projects", []):
        if p.get("name") == project_name:
            return p
    return None


def vercel_find_project_by_repo(repo_full_name, vc_token):
    """Finds the Vercel project linked to a given GitHub repo, independent
    of what the Vercel project happens to be named — a GitHub repo and its
    Vercel project are two separately-renameable things (e.g. repo
    "easydevops" imported into a Vercel project still called
    "Multitenant-agent" from before the repo was renamed), so name-matching
    alone silently fails for any project that doesn't happen to share its
    repo's current name.

    Tries Vercel's server-side `repo=` project filter first (cheapest —
    one filtered call instead of fetching everything), then falls back to
    scanning `link.org/link.repo` on all projects in case the filter
    param's exact matching semantics don't line up with what was passed
    (e.g. repo given as just "name" instead of "owner/name"). Returns
    None (never raises) so callers can uniformly report "not linked" —
    same shape as vercel_find_project's None-on-miss contract.
    """
    r = vc_api("GET", f"/v10/projects?repo={repo_full_name}", vc_token)
    if r.status_code == 200:
        projects = r.json().get("projects", [])
        if len(projects) == 1:
            return projects[0]
        if len(projects) > 1:
            # More than one Vercel project links to the same repo (valid —
            # e.g. separate projects per subdirectory in a monorepo).
            # Nothing to disambiguate on here, so don't guess; let the
            # caller fall through to reporting "not found" rather than
            # silently deploying the wrong one.
            return None

    # Fallback: scan all projects' link.repo for a match. Handles both
    # "owner/name" and bare "name" being passed in, and covers the case
    # where the repo= filter above returned 0 results because of a
    # server-side matching quirk rather than there truly being no link.
    r = vc_api("GET", "/v9/projects", vc_token)
    if r.status_code != 200:
        return None
    repo_name_only = repo_full_name.split("/")[-1].lower()
    for p in r.json().get("projects", []):
        link = p.get("link") or {}
        if link.get("type") != "github":
            continue
        linked_repo = (link.get("repo") or "").lower()
        if linked_repo == repo_full_name.lower() or linked_repo == repo_name_only:
            return p
    return None


def vercel_project_live_url(project):
    """Real production URL for a project, from its latest deployment —
    never guessed from the project name. `<name>.vercel.app` is only a
    valid domain if that exact name happened to be free when the project
    was created; if it wasn't, Vercel assigns something like
    `<name>-<hash>.vercel.app` or `<name>-<team>.vercel.app` instead, and
    a custom domain (if attached) won't match the name at all. Guessing
    the URL from p['name'] sends the user to a domain that may not even
    exist, or to someone else's project.

    Preference order, using the project's `latestDeployments` (the field
    GET /v9/projects already returns per project — no extra API call):
      1. A production alias on the latest deployment (custom domain or
         the real `<name>-xxxx.vercel.app`, whichever Vercel assigned).
      2. The latest deployment's own `url` (always a real, resolvable
         Vercel-assigned hostname, just not necessarily the "prettiest"
         one if a custom domain is attached but not yet reflected here).
      3. None — caller should omit the link entirely rather than
         fabricate one; a missing link is far less confusing than a
         dead/wrong one.
    """
    latest = project.get("latestDeployments") or []
    if not latest:
        return None
    dep = latest[0]
    aliases = dep.get("alias") or []
    if aliases:
        return f"https://{aliases[0]}"
    if dep.get("url"):
        return f"https://{dep['url']}"
    return None


VERCEL_TERMINAL_STATES = {"READY", "ERROR", "CANCELED"}


def vercel_poll_deployment(deployment_id, vc_token, max_wait_seconds=25, interval_seconds=3):
    """Poll GET /v13/deployments/{id} until terminal readyState or timeout.
    Short timeout since this runs synchronously inside one request — Vercel
    serverless functions also have their own execution time limits, so this
    deliberately doesn't try to wait indefinitely for a slow build."""
    elapsed = 0
    last_dep = {}
    while elapsed <= max_wait_seconds:
        r = vc_api("GET", f"/v13/deployments/{deployment_id}", vc_token)
        if r.status_code != 200:
            time.sleep(interval_seconds)
            elapsed += interval_seconds
            continue

        dep = r.json()
        last_dep = dep
        state = dep.get("readyState", "UNKNOWN")

        if state in VERCEL_TERMINAL_STATES:
            live_url = None
            if state == "READY":
                raw_url = dep.get("url")
                if raw_url:
                    live_url = f"https://{raw_url}"
                if dep.get("aliasAssigned") and dep.get("alias"):
                    live_url = f"https://{dep['alias'][0]}"
            return {"ok": state == "READY", "timed_out": False, "deployment": dep, "state": state, "live_url": live_url}

        time.sleep(interval_seconds)
        elapsed += interval_seconds

    return {"ok": False, "timed_out": True, "deployment": last_dep, "state": last_dep.get("readyState", "UNKNOWN"), "live_url": None}
