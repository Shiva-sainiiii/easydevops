"""Render API wrapper."""
import requests


def rd_api(method, endpoint, rd_token, **kwargs):
    url = f"https://api.render.com/v1{endpoint}"
    headers = {
        "Authorization": f"Bearer {rd_token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    return requests.request(method, url, headers=headers, timeout=20, **kwargs)


def rd_list_all_services(rd_token, limit=100, max_total=300):
    """Fetch every service, following Render's cursor pagination: each item
    in the list response is `{"cursor": ..., "service": {...}}` and the
    *last* item's cursor is passed as `?cursor=` to fetch the next page.
    Capped at max_total.

    Returns (items, r) where items keeps the original `{"cursor",
    "service"}` wrapper shape (callers already unwrap `item.get("service",
    item)` the same way the single-page code did) — r is the last response,
    for the caller's existing status-code branching.
    """
    endpoint = f"/services?limit={limit}"
    all_items = []
    r = None
    while endpoint:
        r = rd_api("GET", endpoint, rd_token)
        if r.status_code != 200:
            break
        page = r.json()
        all_items.extend(page)
        if len(all_items) >= max_total or len(page) < limit:
            break
        last_cursor = page[-1].get("cursor")
        if not last_cursor:
            break
        endpoint = f"/services?limit={limit}&cursor={last_cursor}"
    return all_items[:max_total], r
