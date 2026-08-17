"""GitHub API wrapper, used by every GitHub-touching command/route."""
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
