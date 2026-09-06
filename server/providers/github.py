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
