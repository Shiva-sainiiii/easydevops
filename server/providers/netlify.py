"""Netlify API wrapper + site lookup helper."""
import requests


def nl_api(method, endpoint, nl_token, **kwargs):
    url = f"https://api.netlify.com/api/v1{endpoint}"
    headers = {
        "Authorization": f"Bearer {nl_token}",
        "Content-Type": "application/json",
    }
    return requests.request(method, url, headers=headers, timeout=20, **kwargs)


def netlify_find_site(site_name, nl_token):
    """Netlify site IDs and names/subdomains are interchangeable in API
    paths per their docs, but we still resolve to a full site object first
    so callers have the real site_id (needed for some endpoints like env
    vars, which key off account_id, not site_id, so this also gives us
    that context)."""
    r = nl_api("GET", f"/sites/{site_name}", nl_token)
    if r.status_code == 200:
        return r.json()
    return None
