"""
INTENT PARSER — regex-based command matching against the user's raw
message. Kept as one module since SLUG/PATH/INTENT_RULES/parse_intent
are tightly coupled (the rules list and the matcher that walks it belong
together), even though this file ends up sizeable.
"""
import re


SLUG = r"[\w][\w.\-]*"
PATH = r"[\w][\w./\-]*"
CODEGEN_VERBS = r"(?:build|banao|bana\s*do|create|add|fix|karo|update|change|edit|refactor|improve)"
CODEGEN_INSPECT_VERBS_RE = r"\b(?:understand|explain|review|check|what\s+is|kya\s+hai|samjhao|samajh|batao|dekho|dekh)\b"
CODEGEN_STRONG_CHANGE_VERBS_RE = r"\b(?:fix|edit|update|change|add|remove|delete|refactor|debug|improve|build|create|banao|bana|isme|ismein|iska|isko)\b"
CODEGEN_GENERIC_DO_RE = r"\b(?:karo|kar\s*do)\b"

NO_ARG_COMMANDS = {"LIST_REPOS", "VERCEL_LIST_PROJECTS", "NETLIFY_LIST_SITES", "RENDER_LIST_SERVICES"}


def _g(m, i):
    try:
        return m.group(i)
    except (IndexError, AttributeError):
        return None


INTENT_RULES = [
    ("LIST_FILES", [
        rf"(?:list|sare|show|dikhao|dikha)\s+(?:all\s+)?files?\s+(?:in|of|from)\s+({SLUG})",
    ], lambda m: {"repo": _g(m, 1), "path": ""}),

    ("READ_FILE", [
        rf"(?:read|padh|padho|show|dikhao|dikha|open|kholo)\s+(?:the\s+)?file\s+({PATH})\s+(?:from|in|of)\s+({SLUG})",
    ], lambda m: {"repo": _g(m, 2), "path": _g(m, 1)}),

    ("DELETE_FILE", [
        rf"(?:delete|uda|udado|hata|hatao|remove)\s+(?:the\s+)?file\s+({PATH})\s+(?:from|in|of)\s+({SLUG})",
    ], lambda m: {"repo": _g(m, 2), "path": _g(m, 1)}),

    ("EDIT_FILE", [
        rf"(?:edit|change|update|badlo|badal\s*do|modify)\s+(?:the\s+)?file\s+({PATH})\s+(?:in|of)\s+({SLUG})",
    ], lambda m: {"repo": _g(m, 2), "path": _g(m, 1)}),

    ("CREATE_FILE", [
        rf"(?:create|bnao|banao|new|naya)\s+(?:a\s+)?file\s+({PATH})\s+(?:in|inside|for)\s+({SLUG})",
    ], lambda m: {"repo": _g(m, 2), "path": _g(m, 1)}),

    ("CREATE_REPO", [
        rf"(?:create|bnao|banao|naya|new)\s+(?:a\s+|ek\s+)?repo(?:sitory)?\s+"
        rf"(?:called\s+|named\s+)?(?:bnao|banao|bana\s*do)\s+({SLUG})",
        rf"(?:create|bnao|banao|naya|new)\s+(?:a\s+|ek\s+)?repo(?:sitory)?\s+(?:called\s+|named\s+)?({SLUG})",
        rf"repo(?:sitory)?\s+({SLUG})\s+(?:create|bnao|banao|bana(?:\s*do)?)\s*(?:karo|kar\s*do)?$",
    ], lambda m: {"repo": _g(m, 1)}),

    ("DELETE_REPO", [
        rf"(?:delete|uda|udado|hata|hatao|remove)\s+(?:the\s+)?repo(?:sitory)?\s+({SLUG})",
        rf"repo(?:sitory)?\s+({SLUG})\s+(?:delete|uda(?:\s*do)?|hata(?:o|\s*do)?|remove)\s*(?:karo|kar\s*do)?$",
    ], lambda m: {"repo": _g(m, 1)}),

    ("GET_REPO_INFO", [
        rf"(?:info|information|details)\s+(?:about|of|for)\s+(?:repo\s+)?({SLUG})",
        rf"repo\s+info\s+({SLUG})",
        rf"({SLUG})\s+ki\s+info\s+(?:do|dikhao|dikha)",
    ], lambda m: {"repo": _g(m, 1)}),

    ("LIST_REPOS", [
        r"(?:list|sare|mere|show|dikhao|dikha)\s+.*\brepos?\b",
        r"^(?:repos?|my\s+repos?)$",
    ], lambda m: {}),

    # ── VERCEL ──
    ("VERCEL_LIST_PROJECTS", [
        r"(?:list|sare|show|dikhao|dikha)\s+.*vercel.*projects?\b",
        r"^vercel\s+projects?$",
    ], lambda m: {}),

    ("VERCEL_IMPORT_REPO", [
        rf"(?:import|connect)\s+({SLUG})\s+(?:to|pe|on|with)\s+vercel",
    ], lambda m: {"repo": _g(m, 1)}),

    ("VERCEL_DEPLOY", [
        rf"deploy\s+({SLUG})\s+(?:to|pe|on)\s+vercel",
    ], lambda m: {"project_name": _g(m, 1)}),

    ("VERCEL_DELETE_PROJECT", [
        rf"(?:delete|uda|hata)\s+vercel\s+project\s+({SLUG})",
    ], lambda m: {"project_name": _g(m, 1)}),

    ("VERCEL_ROLLBACK", [
        # Ordered deliberately: verb-final Hinglish forms ("X ko rollback
        # karo [to Y]") must be tried before verb-first forms ("rollback
        # X [to Y]") and everything is start-anchored — SLUG is greedy
        # enough to otherwise swallow a trailing verb like "karo" as if it
        # were part of the project name when only searched, not anchored.
        rf"^({SLUG})\s+ko\s+rollback\s+(?:karo|kar\s*do)\s+to\s+([a-zA-Z0-9_-]+)$",
        rf"^({SLUG})\s+(?:ko\s+)?(?:pichli\s+version\s+pe\s+|previous\s+version\s+pe\s+)rollback\s*(?:karo|kar\s*do)?$",
        rf"^({SLUG})\s+ko\s+rollback\s+(?:karo|kar\s*do)$",
        rf"^({SLUG})\s+rollback\s+kar\s*do$",
        rf"^rollback\s+({SLUG})\s+to\s+(?:previous|last|pichli)\s+(?:version|deployment)$",
        rf"^rollback\s+({SLUG})\s+to\s+([a-zA-Z0-9_-]+)$",
        rf"^rollback\s+({SLUG})$",
        rf"^(?:revert|undo)\s+({SLUG})\s+(?:deploy|deployment)$",
    ], lambda m: {"project_name": _g(m, 1), "deployment_id": _g(m, 2)} if len(m.groups()) > 1 and _g(m, 2) else {"project_name": _g(m, 1)}),

    ("VERCEL_LIST_DEPLOYMENTS", [
        rf"({SLUG})\s+(?:ki\s+)?deployments?\s+(?:list|dikhao|dikha|show)",
        rf"(?:list|show|dikhao|dikha)\s+.*deployments?\s+(?:for|of)\s+({SLUG})",
    ], lambda m: {"project_name": _g(m, 1)}),

    ("VERCEL_GET_ENV", [
        rf"(?:get|show|dikhao|dikha)\s+.*env(?:ironment)?(?:\s+vars?)?\s+(?:for|of)\s+({SLUG})\s+.*vercel",
        rf"vercel\s+.*env(?:ironment)?(?:\s+vars?)?\s+(?:for|of)\s+({SLUG})",
    ], lambda m: {"project_name": _g(m, 1)}),

    ("VERCEL_SET_ENV", [
        rf"(?:set|add|update)\s+env\s+(\w+)\s*=\s*(\S+)\s+(?:for|in|on)\s+({SLUG})\s+.*vercel",
        rf"(?:set|add|update)\s+vercel\s+env\s+(\w+)\s*=\s*(\S+)\s+(?:for|in|on)\s+({SLUG})",
    ], lambda m: {"project_name": _g(m, 3), "key": _g(m, 1), "value": _g(m, 2)}),

    # ── NETLIFY ──
    ("NETLIFY_DEPLOY", [
        rf"deploy\s+netlify\s+site\s+({SLUG})",
        rf"deploy\s+({SLUG})\s+to\s+netlify",
        rf"({SLUG})\s+(?:ko\s+)?netlify\s+(?:pe|par)\s+deploy\s+(?:karo|kar\s*do)",
    ], lambda m: {"site_name": _g(m, 1)}),

    ("NETLIFY_LIST_SITES", [
        r"(?:list|sare|show|dikhao|dikha)\s+.*netlify.*sites?\b",
        r"^netlify\s+sites?$",
    ], lambda m: {}),

    ("NETLIFY_DELETE_SITE", [
        rf"(?:delete|uda|hata)\s+netlify\s+site\s+({SLUG})",
    ], lambda m: {"site_name": _g(m, 1)}),

    ("NETLIFY_GET_SITE_INFO", [
        rf"(?:info|information|details)\s+(?:about|of|for)\s+netlify\s+site\s+({SLUG})",
        rf"netlify\s+site\s+info\s+({SLUG})",
    ], lambda m: {"site_name": _g(m, 1)}),

    ("NETLIFY_GET_ENV", [
        rf"(?:get|show|dikhao|dikha)\s+.*env(?:ironment)?(?:\s+vars?)?\s+(?:for|of)\s+({SLUG})\s+.*netlify",
        rf"netlify\s+.*env(?:ironment)?(?:\s+vars?)?\s+(?:for|of)\s+({SLUG})",
    ], lambda m: {"site_name": _g(m, 1)}),

    ("NETLIFY_SET_ENV", [
        rf"(?:set|add|update)\s+env\s+(\w+)\s*=\s*(\S+)\s+(?:for|in|on)\s+({SLUG})\s+.*netlify",
        rf"(?:set|add|update)\s+netlify\s+env\s+(\w+)\s*=\s*(\S+)\s+(?:for|in|on)\s+({SLUG})",
    ], lambda m: {"site_name": _g(m, 3), "key": _g(m, 1), "value": _g(m, 2)}),

    # ── RENDER ──
    ("RENDER_CREATE_SERVICE", [
        rf"(?:create|bana|banao|bana\s*do|new|naya|deploy)\s+(?:a\s+|ek\s+)?(?:new\s+)?render\s+service\s+(?:for|from|of)\s+({SLUG})",
        rf"({SLUG})\s+(?:ka|ke\s+liye)\s+(?:naya\s+)?render\s+service\s+(?:banao|bana\s*do|create)",
        rf"({SLUG})\s+(?:pe|par|ko)\s+render\s+(?:pe|par)\s+(?:naya\s+)?service\s+(?:banao|bana\s*do|create)",
    ], lambda m: {"repo": _g(m, 1)}),

    ("RENDER_LIST_SERVICES", [
        r"(?:list|sare|show|dikhao|dikha)\s+.*render.*services?\b",
        r"(?:list|sare|show|dikhao|dikha)\s+.*services?.*render\b",
        r"^render\s+services?$",
        r"^services?\s+render$",
        r"^render\s+(?:ke\s+)?services?\s+(?:dikhao|dikha|show|list)$",
    ], lambda m: {}),

    ("RENDER_DELETE_SERVICE", [
        rf"(?:delete|uda|udado|hata|hatao|remove)\s+(?:the\s+)?(?:render\s+)?service\s+({SLUG})",
    ], lambda m: {"service_id": _g(m, 1)}),

    ("RENDER_DELETE_SERVICE", [
        rf"({SLUG})\s+service\s+(?:delete|uda(?:o|\s*do)?|hata(?:o|\s*do)?)\s*(?:karo|kar\s*do)?",
    ], lambda m: {"service_id": _g(m, 1)}),

    ("RENDER_GET_ENV", [
        rf"(?:get|show|dikhao|dikha)\s+.*env(?:ironment)?(?:\s+vars?)?\s+(?:for|of)\s+({SLUG})\s+.*render",
        rf"render\s+.*env(?:ironment)?(?:\s+vars?)?\s+(?:for|of)\s+({SLUG})",
    ], lambda m: {"service_id": _g(m, 1)}),

    ("RENDER_SET_ENV", [
        rf"(?:set|add|update)\s+env\s+(\w+)\s*=\s*(\S+)\s+(?:for|in|on)\s+({SLUG})\s+.*render",
        rf"(?:set|add|update)\s+render\s+env\s+(\w+)\s*=\s*(\S+)\s+(?:for|in|on)\s+({SLUG})",
    ], lambda m: {"service_id": _g(m, 3), "env_vars": {_g(m, 1): _g(m, 2)}}),

    ("RENDER_DEPLOY", [
        rf"deploy\s+({SLUG})\s+(?:to|pe|on)\s+render",
    ], lambda m: {"service_id": _g(m, 1)}),

    ("GENERATE_RENDER_YAML", [
        rf"(?:generate|bana|banao|bana\s*do|create)\s+(?:a\s+|ek\s+)?render\.?ya?ml\s+(?:for|in|of)\s+({SLUG})",
        rf"({SLUG})\s+(?:ke\s+liye|ka)\s+render\.?ya?ml\s+(?:generate|bana|banao|bana\s*do)",
        rf"render\.?ya?ml\s+(?:generate|bana|banao|bana\s*do)\s+(?:for|in)\s+({SLUG})",
        rf"^({SLUG})\s+(?:ke\s+liye\s+)?(?:blueprint|iac)\s+(?:generate|bana|banao)",
    ], lambda m: {"repo": _g(m, 1)}),

    # ── CODE_GENERATE (multi-file agentic build/edit) ──
    # Deliberately placed LAST: its patterns are the broadest in this list
    # (any "<verb> ... in <repo>" or "<repo> mein <verb> ..." shape), and
    # rules are tried in list order — so every more specific command above
    # (CREATE_FILE, RENDER_DEPLOY, env-var commands, etc.) gets first look
    # and wins on overlap, e.g. "create file index.html in myrepo" matches
    # CREATE_FILE's pattern earlier in this list, never reaching here.
    ("CODE_GENERATE", [
        rf"^{CODEGEN_VERBS}\b.*\s+(?:in|mein|me)\s+({SLUG})$",
        rf"^({SLUG})\s+(?:mein|me)\s+.*{CODEGEN_VERBS}\b",
    ], lambda m: {"repo": _g(m, 1)}),  # instruction comes from the original message in /chat, not the match
]

COMPLEX_KEYWORDS = [
    "likh", "likho", "banao", "banado", "bnado", "code", "html", "css", "js",
    "javascript", "script", "function", "explain", "samjha", "samjhao",
    "kaise", "kyu", "kyun", "kya", "write", "generate", "design", "navbar",
    "component", "snippet", "fix kar", "debug",
]


def parse_intent(message):
    original = message.strip()
    lowered = original.lower()

    # Several Vercel/Render/Netlify patterns are intentionally loose (no
    # platform keyword required, e.g. "get env vars for X") so short,
    # natural phrasing still matches. But that means a message that
    # explicitly names a DIFFERENT platform ("... for X netlify") could get
    # swallowed by a generic Vercel/Render pattern that runs earlier in the
    # list, before ever reaching the correctly-specific Netlify rule below
    # it. Guard against that directly: if the message names a specific
    # platform, skip every rule belonging to a different one.
    mentioned = {p for p in ("vercel", "render", "netlify") if re.search(rf"\b{p}\b", lowered)}

    def rule_platform(cmd):
        if cmd.startswith("VERCEL_"): return "vercel"
        if cmd.startswith("RENDER_"): return "render"
        if cmd.startswith("NETLIFY_"): return "netlify"
        return None

    for cmd, patterns, extractor in INTENT_RULES:
        rp = rule_platform(cmd)
        if rp and mentioned and rp not in mentioned:
            continue
        for pat in patterns:
            m = re.search(pat, lowered)
            if m:
                try:
                    params = extractor(m)
                except Exception:
                    continue
                required_fields = {"repo", "project_name", "site_name", "service_id", "key"}
                if any(params.get(f) in (None, "") for f in required_fields if f in params):
                    continue
                # VERCEL_SET_ENV / NETLIFY_SET_ENV: env var keys are
                # conventionally uppercase and case-sensitive. The match
                # above ran against the lowercased message, so recover the
                # original casing for the key by re-matching the same span
                # against the original (non-lowered) message.
                if cmd in ("VERCEL_SET_ENV", "NETLIFY_SET_ENV"):
                    orig_m = re.search(pat, original, re.IGNORECASE)
                    if orig_m:
                        params["key"] = orig_m.group(1)
                # RENDER_SET_ENV keeps its key inside env_vars (a dict),
                # not a flat "key" field — same casing-recovery need, just
                # applied to the dict's single entry.
                if cmd == "RENDER_SET_ENV":
                    orig_m = re.search(pat, original, re.IGNORECASE)
                    if orig_m and params.get("env_vars"):
                        real_key = orig_m.group(1)
                        params["env_vars"] = {real_key: list(params["env_vars"].values())[0]}
                return cmd, params
    return None, None
