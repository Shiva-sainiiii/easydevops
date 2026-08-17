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
