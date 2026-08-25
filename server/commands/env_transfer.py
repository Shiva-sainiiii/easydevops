"""
ENV VAR FILE IMPORT/EXPORT — bulk-push a .env file's contents to
Vercel/Netlify/Render in one call, and pull a service/project/site's env
vars back out as a downloadable .env file.

IMPORT works identically for all three platforms: parse → one bulk write
per var (each platform's "set env" API is a per-key call — none of the
three expose a true multi-key-in-one-request bulk endpoint for a single
project/site/service, so this loops and reports partial success the same
way doUploadMany already does for multi-file GitHub uploads).

EXPORT is NOT the same across platforms, and this is a real product
constraint worth being upfront about rather than papering over: Vercel
and Netlify's env-var read APIs return keys only — the values themselves
are encrypted at rest and never returned by the REST API (confirmed by
the existing VERCEL_GET_ENV / NETLIFY_GET_ENV commands in executor.py,
both of which already only display keys for exactly this reason). A
real Vercel .env export with values requires `vercel env pull` run
locally with the Vercel CLI (authenticated interactively) — there's no
API equivalent. So:
  - Render export: full "KEY=value" file, since Render's API is the one
    of the three that does return plaintext values.
  - Vercel/Netlify export: "KEY=" placeholder lines (values blank) plus
    a header comment explaining why, so a downloaded file is still a
    useful starting scaffold (matches the target key set) without
    silently pretending to be a real backup.
"""
import re

from server.providers.vercel import vc_api, vercel_find_project
from server.providers.netlify import nl_api, netlify_find_site
from server.providers.render import rd_api


# Matches "KEY=value", "KEY = value", "export KEY=value", quoted values,
# and skips blank lines / #-comments. Deliberately simple (no multi-line
# quoted-value support) since that covers the overwhelming majority of
# real .env files and a hand-edited env file failing to parse loudly is
# safer than one silently mis-parsing.
_ENV_LINE_RE = re.compile(
    r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$'
)


class EnvParseError(Exception):
    pass


def parse_env_file(text):
    """Parses .env file text into an ordered dict of {key: value}. Strips
    matching surrounding quotes (single or double) from values, same as
    how dotenv-style files are conventionally read. Raises EnvParseError
    with the offending line number if a non-blank, non-comment line
    doesn't match KEY=value shape, so a malformed upload fails clearly
    instead of silently dropping lines."""
    result = {}
    for lineno, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        m = _ENV_LINE_RE.match(line)
        if not m:
            raise EnvParseError(f"Line {lineno} samajh nahi aayi: `{raw_line.strip()[:60]}`")
        key, value = m.group(1), m.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        result[key] = value
    if not result:
        raise EnvParseError("File me koi valid KEY=value line nahi mili.")
    return result


MAX_ENV_VARS_PER_IMPORT = 100


def import_env_vars(platform, target_name, env_dict, vc_token=None, nl_token=None, rd_token=None):
    """Bulk-sets env_dict on the named Vercel project / Netlify site /
    Render service. Returns an execute_command-shaped result dict, same
    partial-failure-tolerant reporting style as doUploadMany's frontend
    summary (ok_count / failed keys), since a 40-key .env file hitting a
    rate limit partway through shouldn't look like a total failure."""
    if len(env_dict) > MAX_ENV_VARS_PER_IMPORT:
        return {"reply": f"❌ {len(env_dict)} vars ek file me — {MAX_ENV_VARS_PER_IMPORT} se zyada ek baar me support nahi hai.", "action": "error"}

    if platform == "vercel":
        return _import_vercel(target_name, env_dict, vc_token)
    if platform == "netlify":
        return _import_netlify(target_name, env_dict, nl_token)
    if platform == "render":
        return _import_render(target_name, env_dict, rd_token)
    return {"reply": f"❌ Platform `{platform}` pehchana nahi.", "action": "error"}


def _import_vercel(project_name, env_dict, vc_token):
    if not vc_token:
        return {"reply": "🔒 Pehle Vercel connect karo — user menu me 'Connect Vercel' dabao.", "action": "vercel_auth_required"}
    proj = vercel_find_project(project_name, vc_token)
    if not proj:
        return {"reply": f"❌ Vercel project `{project_name}` nahi mila.", "action": "error"}
    proj_id = proj.get("id")

    ok_keys, failed = [], []
    for key, value in env_dict.items():
        r = vc_api("POST", f"/v10/projects/{proj_id}/env", vc_token,
                   json={"key": key, "value": value, "type": "encrypted",
                         "target": ["production", "preview", "development"]})
        if r.status_code in (200, 201):
            ok_keys.append(key)
        elif r.status_code in (401, 403):
            return {"reply": "❌ Vercel token invalid ya expire ho gaya. Dubara connect karo.", "action": "vercel_auth_required"}
        else:
            failed.append(key)

    return _import_summary("Vercel", project_name, ok_keys, failed, "vercel_env_set")


def _import_netlify(site_name, env_dict, nl_token):
    if not nl_token:
        return {"reply": "🔒 Pehle Netlify connect karo — user menu me 'Connect Netlify' dabao.", "action": "netlify_auth_required"}
    site = netlify_find_site(site_name, nl_token)
    if not site:
        return {"reply": f"❌ Netlify site `{site_name}` nahi mili.", "action": "error"}
    account_id = site.get("account_id")
    if not account_id:
        return {"reply": "❌ Is site ka account_id nahi mila.", "action": "error"}

    ok_keys, failed = [], []
    for key, value in env_dict.items():
        payload = {
            "key": key,
            "scopes": ["builds", "functions", "runtime", "post_processing"],
            "values": [{"value": value, "context": "all"}],
        }
        r = nl_api("POST", f"/accounts/{account_id}/env?site_id={site['id']}", nl_token, json=payload)
        if r.status_code in (200, 201):
            ok_keys.append(key)
        elif r.status_code in (401, 403):
            return {"reply": "❌ Netlify token invalid ya expire ho gaya. Dubara connect karo.", "action": "netlify_auth_required"}
        else:
            failed.append(key)

    return _import_summary("Netlify", site_name, ok_keys, failed, "netlify_env_set")


def _import_render(service_id, env_dict, rd_token):
    if not rd_token:
        return {"reply": "🔒 Pehle Render connect karo — user menu me 'Connect Render' dabao.", "action": "render_auth_required"}

    # Render's env-vars endpoint is a full PUT (replace-all), same as the
    # existing RENDER_SET_ENV command — so read what's already there and
    # merge the imported keys in, rather than wiping every var the
    # service currently has.
    existing_r = rd_api("GET", f"/services/{service_id}/env-vars?limit=100", rd_token)
    existing = {}
    if existing_r.status_code == 200:
        for item in existing_r.json():
            existing[item["envVar"]["key"]] = item["envVar"]["value"]
    elif existing_r.status_code in (401, 403):
        return {"reply": "❌ Render token invalid ya expire ho gaya. Dubara connect karo.", "action": "render_auth_required"}

    existing.update(env_dict)
    payload = [{"key": k, "value": v} for k, v in existing.items()]
    r = rd_api("PUT", f"/services/{service_id}/env-vars", rd_token, json=payload)
    if r.status_code in (200, 201):
        return _import_summary("Render", service_id, list(env_dict.keys()), [], "render_env_update")
    elif r.status_code in (401, 403):
        return {"reply": "❌ Render token invalid ya expire ho gaya. Dubara connect karo.", "action": "render_auth_required"}
    else:
        return {"reply": f"❌ Env import Error: {r.text[:200]}", "action": "error"}


def _import_summary(platform_label, target_name, ok_keys, failed, action):
    if not ok_keys and failed:
        return {"reply": f"❌ Koi bhi env var import nahi hua `{target_name}` me. Fail hui: {', '.join(failed)}", "action": "error"}
    keys_line = ", ".join(f"`{k}`" for k in ok_keys)
    reply = f"✅ {len(ok_keys)} env vars import ho gaye `{target_name}` ({platform_label}) me!\n{keys_line}"
    if failed:
        reply += f"\n\n⚠️ Fail hui: {', '.join(failed)}"
    reply += "\n\n⚠️ Naya deploy trigger karo changes apply karne ke liye."
    return {"reply": reply, "action": action, "imported": ok_keys, "failed": failed}


def export_env_file(platform, target_name, vc_token=None, nl_token=None, rd_token=None):
    """Returns (filename, file_text, warning|None) for download, or a dict
    with an 'error' key if the lookup itself failed (auth/not-found) —
    kept as a distinct return shape from import_env_vars's chat-reply dict
    since this feeds a file download route, not a chat bubble."""
    if platform == "render":
        return _export_render(target_name, rd_token)
    if platform == "vercel":
        return _export_vercel(target_name, vc_token)
    if platform == "netlify":
        return _export_netlify(target_name, nl_token)
    return {"error": f"Platform `{platform}` pehchana nahi."}


def _export_render(service_id, rd_token):
    if not rd_token:
        return {"error": "Render connected nahi hai."}
    r = rd_api("GET", f"/services/{service_id}/env-vars?limit=100", rd_token)
    if r.status_code in (401, 403):
        return {"error": "Render token invalid ya expire ho gaya."}
    if r.status_code != 200:
        return {"error": f"Env vars fetch nahi hue: {r.text[:200]}"}
    items = r.json()
    lines = [f"{item['envVar']['key']}={item['envVar']['value']}" for item in items]
    text = "\n".join(lines) + ("\n" if lines else "")
    return (f"{service_id}.env", text, None)


def _export_vercel(project_name, vc_token):
    if not vc_token:
        return {"error": "Vercel connected nahi hai."}
    proj = vercel_find_project(project_name, vc_token)
    if not proj:
        return {"error": f"Vercel project `{project_name}` nahi mila."}
    r = vc_api("GET", f"/v9/projects/{proj.get('id')}/env", vc_token)
    if r.status_code in (401, 403):
        return {"error": "Vercel token invalid ya expire ho gaya."}
    if r.status_code != 200:
        return {"error": f"Env vars fetch nahi hue: {r.text[:200]}"}
    envs = r.json().get("envs", [])
    warning = ("Vercel apni env var VALUES kabhi API se return nahi karta (encrypted-at-rest) — "
               "ye sirf KEYS ka scaffold hai, values manually bharni padengi. Full backup ke liye "
               "`vercel env pull` CLI command use karo.")
    lines = [f"{e['key']}=" for e in envs]
    text = "\n".join(lines) + ("\n" if lines else "")
    return (f"{project_name}.env", text, warning)


def _export_netlify(site_name, nl_token):
    if not nl_token:
        return {"error": "Netlify connected nahi hai."}
    site = netlify_find_site(site_name, nl_token)
    if not site:
        return {"error": f"Netlify site `{site_name}` nahi mili."}
    account_id = site.get("account_id")
    if not account_id:
        return {"error": "Is site ka account_id nahi mila."}
    r = nl_api("GET", f"/accounts/{account_id}/env?site_id={site['id']}", nl_token)
    if r.status_code in (401, 403):
        return {"error": "Netlify token invalid ya expire ho gaya."}
    if r.status_code != 200:
        return {"error": f"Env vars fetch nahi hue: {r.text[:200]}"}
    envs = r.json()
    warning = ("Netlify apni env var VALUES API se return nahi karta (encrypted-at-rest) — "
               "ye sirf KEYS ka scaffold hai, values manually bharni padengi.")
    lines = [f"{e['key']}=" for e in envs]
    text = "\n".join(lines) + ("\n" if lines else "")
    return (f"{site_name}.env", text, warning)
