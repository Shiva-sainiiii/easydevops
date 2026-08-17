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
