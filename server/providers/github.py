"""GitHub API wrapper, used by every GitHub-touching command/route."""
import re
import requests


def gh_api(method, endpoint, gh_token, **kwargs):
    url = f"https://api.github.com{endpoint}"
    headers = {
        "Authorization": f"Bearer {gh_token}",
        "Accept": "application/vnd.github+json",
    }
    return requests.request(method, url, headers=headers, timeout=20, **kwargs)


def get_file_sha(repo, path, owner, gh_token):
    r = gh_api("GET", f"/repos/{owner}/{repo}/contents/{path}", gh_token)
    if r.status_code == 200:
        return r.json().get("sha")
    return None


_LINK_NEXT_RE = re.compile(r'<([^>]+)>;\s*rel="next"')


def gh_list_all_repos(gh_token, per_page=100, max_total=300):
    """Fetch every repo the user owns, following the `Link: rel="next"`
    header instead of trusting a single page. Capped at max_total so a
    single request can't hang forever for a huge account.

    Returns (repos, r) where r is the last response object (for status-code
    checks by the caller) — mirrors the single-call sites this replaces,
    which all branch on r.status_code after the fetch.
    """
    endpoint = f"/user/repos?per_page={per_page}&sort=updated&affiliation=owner"
    all_repos = []
    r = None
    while endpoint:
        r = gh_api("GET", endpoint, gh_token)
        if r.status_code != 200:
            break
        page = r.json()
        all_repos.extend(page)
        if len(all_repos) >= max_total or len(page) < per_page:
            break
        link_header = r.headers.get("Link", "")
        match = _LINK_NEXT_RE.search(link_header)
        if not match:
            break
        # Link header gives a full URL; gh_api wants a path+query only.
        next_url = match.group(1)
        endpoint = next_url.split("api.github.com", 1)[-1]
    return all_repos[:max_total], r


def gh_get_check_runs(repo, ref, owner, gh_token):
    """Fetch GitHub Actions check-runs for a commit/branch ref via
    `/repos/{owner}/{repo}/commits/{ref}/check-runs`. `ref` can be a
    branch name, tag, or SHA — GitHub resolves it to the tip commit.

    Returns (check_runs, r) — same (data, response) shape as
    gh_list_all_repos, so callers branch on r.status_code the same way.
    check_runs is the raw `check_runs` array from the API (empty list if
    the repo has no Actions workflows at all, which is a 200 with an
    empty array, not an error).
    """
    r = gh_api("GET", f"/repos/{owner}/{repo}/commits/{ref}/check-runs?per_page=100", gh_token)
    if r.status_code == 200:
        return r.json().get("check_runs", []), r
    return [], r


def summarize_check_runs(check_runs):
    """Reduce a raw check_runs array down to the small summary shape both
    GITHUB_CHECK_STATUS and the repo_info badge need: overall state +
    pass/fail/pending counts + the per-check list for the detail card.

    Overall state priority: any run still queued/in_progress wins (CI
    still running) over a failure, so a badge doesn't flash red for a
    run that hasn't finished yet; failure only wins once nothing is
    still pending.
    """
    if not check_runs:
        return {"state": "none", "total": 0, "passed": 0, "failed": 0, "pending": 0, "checks": []}

    passed = failed = pending = 0
    checks = []
    for c in check_runs:
        status = c.get("status")  # queued | in_progress | completed
        conclusion = c.get("conclusion")  # success | failure | neutral | cancelled | skipped | timed_out | action_required | None
        if status != "completed":
            pending += 1
            run_state = "pending"
        elif conclusion == "success":
            passed += 1
            run_state = "success"
        elif conclusion in ("skipped", "neutral"):
            run_state = "skipped"
        else:
            failed += 1
            run_state = "failure"
        checks.append({
            "name": c.get("name"),
            "state": run_state,
            "conclusion": conclusion,
            "url": c.get("html_url"),
        })

    if pending:
        overall = "pending"
    elif failed:
        overall = "failure"
    else:
        overall = "success"

    return {"state": overall, "total": len(check_runs), "passed": passed,
            "failed": failed, "pending": pending, "checks": checks}
