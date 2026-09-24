"""Netlify API wrapper + site lookup helper."""
import re
import requests


def nl_api(method, endpoint, nl_token, **kwargs):
    url = f"https://api.netlify.com/api/v1{endpoint}"
    headers = {
        "Authorization": f"Bearer {nl_token}",
        "Content-Type": "application/json",
    }
    return requests.request(method, url, headers=headers, timeout=20, **kwargs)


_NL_LINK_NEXT_RE = re.compile(r'<([^>]+)>;\s*rel="next"')


def nl_list_all_sites(nl_token, per_page=100, max_total=300):
    """Fetch every site, following Netlify's page/per_page + Link-header
    pagination (same contract as GitHub's). Capped at max_total.

    Returns (sites, r) — r is the last response, for the caller's existing
    status-code branching.
    """
    endpoint = f"/sites?per_page={per_page}"
    all_sites = []
    r = None
    while endpoint:
        r = nl_api("GET", endpoint, nl_token)
        if r.status_code != 200:
            break
        page = r.json()
        all_sites.extend(page)
        if len(all_sites) >= max_total or len(page) < per_page:
            break
        link_header = r.headers.get("Link", "")
        match = _NL_LINK_NEXT_RE.search(link_header)
        if not match:
            break
        next_url = match.group(1)
        endpoint = next_url.split("api.netlify.com/api/v1", 1)[-1]
    return all_sites[:max_total], r


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
