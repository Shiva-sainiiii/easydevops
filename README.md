<div align="center">

# ⚡ DevOps Agent

### Chat karke apna GitHub, Vercel, Netlify aur Render control karo — Hinglish me, phone se.

</div>

---

A multi-tenant, chat-driven DevOps assistant. Every user connects their
**own** GitHub (via OAuth), and optionally their own Vercel/Netlify/Render
(via a pasted API token) — then controls all of it through natural-language
chat, in English or Hinglish: create/delete repos, read/write files, deploy
projects, manage env vars, roll back bad deployments, generate IaC blueprints,
even ask the AI to write and commit multi-file code changes directly into a
repo. No CLI, no dashboard-hopping — one chat box for the whole pipeline.

🔗 **Live:** deployed on Vercel (see [Deploying](#deploying-to-vercel) below
for standing up your own instance)

---

## Table of Contents

- [What it does](#what-it-does)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Project structure](#project-structure)
- [Auth & multi-tenancy](#auth--multi-tenancy)
- [The command system](#the-command-system)
- [Full command list](#full-command-list)
- [Safety & security](#safety--security)
- [Local setup](#local-setup)
- [Deploying to Vercel](#deploying-to-vercel)
- [SEO / Search Console](#seo--search-console)
- [Known limitations](#known-limitations)
- [Credits](#credits)

---

## What it does

- **Bring-your-own-everything**: every user logs in with their own GitHub
  account (real OAuth) and optionally pastes their own Vercel/Netlify/Render
  API token. This server never touches a shared/company account — every
  action executes against *that specific user's own* connected accounts,
  fully isolated per user.
- **Chat-driven GitHub control**: create/delete repos, list repos, get repo
  info, list/read/create/edit/delete files, upload a single file or a whole
  zip (extracted and pushed as one commit), download a file or a whole repo
  as a zip.
- **Chat-driven Vercel control**: list projects, import a GitHub repo as a
  new project, trigger a deploy, delete a project, get/set environment
  variables, list deployments, roll back to a previous production
  deployment — plus a live build-log polling endpoint the UI uses to stream
  deploy progress in a terminal-style drawer.
- **Chat-driven Netlify & Render control**: list sites/services, get site
  info, delete a site/service, get/set env vars (Render also supports
  triggering a redeploy).
- **Infrastructure-as-Code generation**: `GENERATE_RENDER_YAML` inspects a
  repo's root-level files (framework-signature detection — no cloning, no
  code execution) and commits a working `render.yaml` blueprint.
- **Agentic multi-file code generation**: ask it to build a feature or fix a
  bug in plain language, and it plans, generates, and commits a coordinated
  multi-file change (up to 20 files) to the repo as a single commit — with
  a short plain-English explanation of what it did and why.
- **Understands English and Hinglish**: a regex-based intent parser matches
  natural phrasing in both languages first (fast, free, deterministic); an
  AI fallback only kicks in when nothing structural matches, so common
  commands never need a network round-trip to an LLM just to be understood.
- **Destructive-action confirmation**: anything that deletes or rolls back
  something (repos, files, projects, sites, services, bulk operations)
  always requires an explicit "haan/yes" confirmation before it executes —
  never fires from a single ambiguous message.
- **Bulk actions**: multi-select delete across files, repos, or Vercel
  projects from the UI's list views, with the same confirmation gate and
  per-item partial-failure reporting (one failure doesn't abort the rest).
- **Persistent, multi-session chat history**: conversations are saved
  server-side (Firestore) per user, not just in the browser — switch
  devices or clear your cache and your chat history is still there. Create
  new chats, switch between old ones, delete any of them.
- **AI error analysis**: when a Vercel deployment fails, the deploy-log
  drawer can ask the AI to read the build log and explain what went wrong
  in plain language.

## Tech stack

| Layer | Choice |
|---|---|
| Backend | Python · Flask · Flask-CORS |
| Hosting | Vercel serverless functions (`@vercel/python`) |
| Auth | GitHub OAuth Apps (`repo` + `delete_repo` scopes) |
| Sessions | Stateless, signed cookies (`itsdangerous`) — no server-side session store |
| Token storage | Neon (managed Postgres), `psycopg2` — Fernet-encrypted at rest |
| Chat history storage | Firestore (via `firebase-admin`), keyed by the same user id as Postgres |
| Encryption | `cryptography` (Fernet) for every stored provider token |
| Providers | GitHub REST API, Vercel API, Netlify API, Render API (thin `requests`-based wrappers) |
| AI layer | OpenRouter (app-level shared key) — intent fallback + code generation only, never given any user's provider token |
| Frontend | Vanilla HTML/CSS/JS — **no framework, no build step** |

No client-side framework, no bundler — `script.js` and `style.css` are
served as-is. On the backend, `requirements.txt` is the full dependency
list; no `npm install` is needed anywhere in this repo.

## Architecture

```
┌─────────────┐        signed cookie (user_id)        ┌──────────────────────┐
│   Browser    │ ─────────────────────────────────────► │  Flask app (Vercel)   │
│  (script.js) │ ◄───────────────────────────────────── │  server/ package       │
└─────────────┘              JSON responses             └──────────┬───────────┘
                                                                    │
                     ┌──────────────────────┬──────────────────────┼─────────────────────┐
                     ▼                      ▼                      ▼                     ▼
              Neon Postgres           Firestore              GitHub API          Vercel / Netlify /
          (encrypted provider      (chat session          (per-user OAuth        Render APIs (per-
              tokens, per user)      history, per user)      token)              user pasted token)
                                                                                          │
                                                                                          ▼
                                                                                  OpenRouter (app-level
                                                                                  key — intent fallback
                                                                                  + code generation only)
```

There's no long-lived process — Vercel spins up a fresh, isolated instance
of the Flask app per request. That's why token storage moved to a real
network database (Neon Postgres) instead of a local SQLite file (which
would vanish between invocations), and why the session is a **stateless
signed cookie** rather than Flask's default server-side session (which
also needs somewhere persistent to live). See the comment header of
`server/config.py` for the full reasoning.

## Project structure

```
easydevops/
├── app.py                        # WSGI entrypoint — the ONLY file Vercel's
│                                  # @vercel/python builder points at.
│                                  # Deliberately 2 lines: from server import
│                                  # create_app; app = create_app()
├── index.html                     # Single-page chat UI: login gate, chat
│                                  # window, provider-connect modals, deploy
│                                  # terminal drawer, chat history sidebar
├── script.js                       # All frontend logic: auth check, chat
│                                  # send/stream, session history rendering,
│                                  # file/zip upload, provider connect flows,
│                                  # confirm-dialog handling, hex loader anim
├── style.css                        # All styling (default + AMOLED theme)
├── requirements.txt                  # flask, flask-cors, requests,
│                                  # python-dotenv, cryptography,
│                                  # itsdangerous, psycopg2-binary,
│                                  # firebase-admin
├── vercel.json                        # Tells Vercel app.py is the Python
│                                  # entrypoint and routes everything to it
├── .env.example                        # Every required env var, documented
├── server/
│   ├── __init__.py                     # App factory: creates the Flask app,
│   │                                # wires CORS, calls init_db()/
│   │                                # init_firestore() once at startup,
│   │                                # registers every blueprint
│   ├── config.py                        # Env var loading + fail-fast
│   │                                # validation (raises at import time if
│   │                                # anything required is missing)
│   ├── auth.py                           # Signed-cookie session helpers +
│   │                                # current_user()/require_login()
│   ├── db.py                              # Neon Postgres: users table,
│   │                                # Fernet encrypt/decrypt, per-provider
│   │                                # token get/set/clear (GitHub is
│   │                                # required at signup; Vercel/Netlify/
│   │                                # Render are optional, added later)
│   ├── firestore_db.py                     # Firestore: multi-session chat
│   │                                # history persistence, per user
│   ├── security.py                          # safe_jsonify() (redacts
│   │                                # secrets from every response) +
│   │                                # safe_repo_path() (path-traversal guard
│   │                                # for every GitHub write surface)
│   ├── providers/
│   │   ├── github.py                        # GitHub REST wrapper
│   │   ├── vercel.py                         # Vercel API wrapper + project/
│   │                                     # deployment helpers
│   │   ├── netlify.py                         # Netlify API wrapper
│   │   └── render.py                           # Render API wrapper
│   ├── commands/
│   │   ├── intent_parser.py                    # Regex rules matching
│   │                                     # English + Hinglish phrasing to
│   │                                     # one of ~29 direct commands
│   │   ├── executor.py                          # execute_command() — the
│   │                                     # single dispatcher every matched
│   │                                     # intent (and every AI-emitted
│   │                                     # command) runs through
│   │   ├── ai_fallback.py                        # OpenRouter call for
│   │                                     # anything the regex parser
│   │                                     # doesn't match, constrained to
│   │                                     # emit exactly one known command
│   │   ├── code_generate.py                       # Agentic multi-file
│   │                                     # build/edit: structured-JSON
│   │                                     # contract, diff-apply engine,
│   │                                     # single-commit push (up to 20
│   │                                     # files per request)
│   │   ├── bulk_actions.py                         # Multi-select bulk
│   │                                     # delete (files/repos/Vercel
│   │                                     # projects), confirm-gated,
│   │                                     # partial-failure tolerant
│   │   ├── confirmation.py                          # Builds + verifies the
│   │                                     # "are you sure?" token for every
│   │                                     # destructive command
│   │   └── render_blueprint.py                        # Framework-signature
│   │                                     # detection → generates and
│   │                                     # commits a render.yaml
│   └── routes/
│       ├── auth_routes.py                             # GitHub OAuth login/
│                                                # callback/logout, /api/me
│       ├── chat_routes.py                              # /chat — the main
│                                                # command entrypoint
│                                                # (3-stage dispatch, see
│                                                # below)
│       ├── provider_routes.py                          # Connect/disconnect
│                                                # Vercel/Netlify/Render
│                                                # (manual token paste) +
│                                                # token pre-validation
│       ├── file_routes.py                              # Single-file
│                                                # download/upload, whole-repo
│                                                # zip download, zip-upload →
│                                                # extract → single-commit push
│       ├── session_routes.py                            # /api/sessions/* —
│                                                # Firestore-backed chat
│                                                # history CRUD
│       └── static_routes.py                              # Serves index.html,
│                                                # style.css, script.js,
│                                                # favicons, robots.txt,
│                                                # sitemap.xml from repo root
```

## Auth & multi-tenancy

```
User taps "Connect GitHub"
        │
        ▼
GitHub OAuth authorize page (scopes: repo, delete_repo)
        │   CSRF state stored in a short-lived (10 min) signed cookie
        ▼
GET /auth/github/callback?code=...&state=...
        │   state verified against the cookie → code exchanged for an
        │   access token → identity fetched (github_id, login, avatar)
        ▼
Neon Postgres: upsert user row, GitHub token Fernet-encrypted at rest
        │
        ▼
Signed session cookie set: { user_id }  (itsdangerous, 30-day expiry,
                                          httponly, Secure in prod)
        │
        ▼
Every /chat (or other authenticated) request:
   cookie signature verified (no DB hit needed just to authenticate)
        → user_id resolved → their row fetched → their token decrypted
        → API call made against THAT user's own GitHub/Vercel/Netlify/
          Render account only
```

- **GitHub** uses real OAuth — the only provider that does, since it's the
  identity anchor for the whole account.
- **Vercel, Netlify, and Render** are connected by the user **pasting their
  own API token/key** (via a menu modal), not OAuth. Each has a specific
  reason documented in `server/routes/provider_routes.py` / `db.py`:
  Vercel's "Sign in with Vercel" OAuth flow is identity-focused rather than
  built for deployment-management scopes; Netlify's own docs recommend a
  Personal Access Token as the first-class path for third-party tools;
  Render has no public OAuth at all. Every pasted token is validated with a
  real "who am I" call before being saved, and Fernet-encrypted in Postgres
  exactly like the GitHub token.
- Disconnecting any provider (including full logout) immediately clears
  that token from the database — nothing lingers.

## The command system

`POST /chat` resolves a message in three stages (see the header comment in
`server/routes/chat_routes.py`):

1. **Confirmed destructive-action replay** — if the previous turn returned
   a `confirm_required` prompt and the user just said yes, the exact same
   command/params are replayed (matched by a token bound to
   `(command, value, user_id)`, so it can't be replayed as a different
   user or against different params).
2. **Structural intent match** — `server/commands/intent_parser.py` runs a
   list of regex rules (English + Hinglish phrasing both supported) against
   the raw message. A match routes straight to `execute_command()` — no AI
   call, no latency, fully deterministic. `CREATE_FILE`/`EDIT_FILE` with no
   content specified, and `CODE_GENERATE`, still involve an AI call for the
   *content*, but the *routing decision* itself is still regex-driven.
3. **Full AI fallback** — only reached when nothing structural matches.
   `server/commands/ai_fallback.py` sends the message to an OpenRouter model
   with a system prompt listing every available command (scoped to which
   providers this specific user has actually connected) and strict output
   rules — the model is constrained to emit exactly one known command, which
   then still runs through the exact same `execute_command()` every
   regex-matched intent uses. The AI never receives any user's provider
   token, and its output never reaches GitHub/Vercel/etc. directly — it
   only ever reaches them through the same trusted executor path.

This split matters for cost and reliability: the ~29 most common actions
resolve instantly and for free via regex, and only genuinely ambiguous or
conversational input pays for a model call.

## Full command list

| Command | What it does |
|---|---|
| `CREATE_REPO` / `DELETE_REPO` / `LIST_REPOS` / `GET_REPO_INFO` | GitHub repo lifecycle |
| `CREATE_FILE` / `READ_FILE` / `EDIT_FILE` / `DELETE_FILE` / `LIST_FILES` | GitHub file CRUD |
| `CODE_GENERATE` | Agentic multi-file build/edit, committed as one commit |
| `GENERATE_RENDER_YAML` | Detects the repo's stack, commits a `render.yaml` blueprint |
| `VERCEL_LIST_PROJECTS` / `VERCEL_IMPORT_REPO` / `VERCEL_DEPLOY` / `VERCEL_DELETE_PROJECT` | Vercel project lifecycle |
| `VERCEL_GET_ENV` / `VERCEL_SET_ENV` | Vercel environment variables |
| `VERCEL_ROLLBACK` / `VERCEL_LIST_DEPLOYMENTS` | Vercel deployment history & rollback |
| `NETLIFY_LIST_SITES` / `NETLIFY_GET_SITE_INFO` / `NETLIFY_DELETE_SITE` | Netlify site lifecycle |
| `NETLIFY_GET_ENV` / `NETLIFY_SET_ENV` | Netlify environment variables |
| `RENDER_LIST_SERVICES` / `RENDER_DELETE_SERVICE` / `RENDER_DEPLOY` | Render service lifecycle |
| `RENDER_GET_ENV` / `RENDER_SET_ENV` | Render environment variables |
| `BULK_DELETE_FILES` / `BULK_DELETE_REPOS` / `BULK_DELETE_VERCEL_PROJECTS` | Multi-select bulk delete from list views |

Plus file-level HTTP routes outside the chat protocol: single-file
download/upload, whole-repo zip download, and zip-upload → extract →
single-commit push.

## Safety & security

- **Signed, not encrypted, session cookie** — it only ever carries a
  `user_id`, which isn't sensitive on its own, so tamper-proofing
  (`itsdangerous`) is sufficient; the actual secrets live encrypted in
  Postgres.
- **Every provider token is Fernet-encrypted at rest** — a database
  compromise alone doesn't leak usable tokens without `FERNET_KEY`, which
  only lives in this server's own environment.
- **Per-request secret redaction** (`server/security.py`) — every JSON
  response is scrubbed for the current user's decrypted tokens plus
  pattern-shaped secrets (GitHub PAT/OAuth formats, OpenRouter keys, Render
  keys, bearer tokens) before it leaves the server, regardless of which
  code path produced the response.
- **Path-traversal guard on every GitHub write** — `safe_repo_path()` is
  used by `CREATE_FILE`/`EDIT_FILE`/`DELETE_FILE`, the multi-file codegen
  commit, and both upload routes. It rejects `..` segments, absolute-looking
  paths, and any write targeting `.github/` outright — closing the "zip slip"
  class of bug where an attacker-controlled path (typed, AI-emitted, or
  hidden inside a zip entry name) could otherwise land outside the intended
  location.
- **Destructive-action confirmation is mandatory** — repo/file/project/
  site/service deletion and Vercel rollbacks always require a confirm step;
  the confirm token is bound to `(command, params, user_id)` so it can't be
  replayed cross-user or against different params even if leaked.
- **No cross-user token use, structurally** — `execute_command()` always
  receives the *calling* user's own decrypted token; there is no code path
  that accepts an arbitrary "owner" from the request.
- **The AI layer never sees a provider token** — OpenRouter is used purely
  for language understanding and code generation, with its own app-level
  key; its output only ever reaches GitHub/Vercel/etc. by being routed back
  through the same trusted `execute_command()` every regex-matched command
  uses.

## Local setup

```bash
git clone <this-repo>
cd easydevops
pip install -r requirements.txt
cp .env.example .env
# fill in every value in .env — see the next section for where each comes from
python app.py   # or: flask --app app run
```

By default the app listens on `http://localhost:5000`.

### Getting each required value

| Variable | Where it comes from |
|---|---|
| `FLASK_SECRET_KEY` | `python -c "import secrets; print(secrets.token_hex(32))"` |
| `FERNET_KEY` | `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App**. Callback URL must be `{APP_BASE_URL}/auth/github/callback` |
| `OPENROUTER_KEY` | [openrouter.ai](https://openrouter.ai) — app-level, shared AI-fallback infra |
| `APP_BASE_URL` | `http://localhost:5000` locally, your production URL when deployed (no trailing slash) |
| `DATABASE_URL` | [neon.tech](https://neon.tech) → New Project → copy the connection string (pooled, if offered) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase Console → Project settings → Service accounts → **Generate new private key** → paste the *entire* downloaded JSON file's contents as one env var value (not a file path — Vercel's filesystem is read-only at runtime, so this can't be a mounted key file) |
| `FLASK_ENV` | Set to `development` locally so the session cookie's `Secure` flag is relaxed (otherwise login is blocked on plain HTTP) |

For local testing, set your GitHub OAuth App's callback to
`http://localhost:5000/auth/github/callback` and keep `APP_BASE_URL`
matching it exactly.

## Deploying to Vercel

1. Push this repo to GitHub.
2. Vercel dashboard → **New Project** → import the repo. `vercel.json`
   already tells Vercel that `app.py` is the Python entrypoint and that
   every route should go through it.
3. Add every variable from `.env.example` (with production values) under
   **Project → Settings → Environment Variables**.
4. Deploy.
5. Update your GitHub OAuth App's callback URL to the production URL
   (`https://your-app.vercel.app/auth/github/callback`).
6. Update `APP_BASE_URL` in Vercel's env vars to match the production URL,
   then redeploy so the new value takes effect.

## SEO / Search Console

Favicons, meta tags, `robots.txt`, and `sitemap.xml` are already in the
repo and go live automatically on deploy — no extra config needed. To get
listed on Google (manual, one-time):

1. Add your production URL as a property in
   [Google Search Console](https://search.google.com/search-console).
2. Verify ownership — easiest is the HTML tag method: paste the
   `<meta name="google-site-verification" ...>` tag Search Console gives
   you into `index.html`'s `<head>`, then click Verify.
3. Once verified, submit `sitemap.xml` under Search Console's **Sitemaps**
   section.
4. Use **URL Inspection** on your homepage and click "Request Indexing" to
   speed up the first crawl.

If your domain ever changes, update the canonical/`og:url`/`og:image` URLs
in `index.html`'s `<head>`, plus the domain in both `robots.txt` and
`sitemap.xml`.

## Known limitations

- Vercel/Netlify/Render connections rely on the user correctly pasting a
  valid token/key — there's no OAuth safety net for those three the way
  there is for GitHub.
- `CODE_GENERATE` caps out at 20 files per request and a fixed context-size
  budget of existing file content sent to the model — very large repos or
  sprawling multi-file refactors may need to be split into several requests.
- The regex intent parser covers common English/Hinglish phrasings but
  isn't exhaustive; sufficiently unusual phrasing falls through to the AI
  fallback (slower, costs a model call) rather than failing outright, which
  is intentional but worth knowing.
- Chat history is capped (50 sessions, 200 messages per session) — oldest
  sessions/messages roll off past that.
- No team/organization support — this is single-user-per-account, one
  GitHub login per session.

## Credits

Built solo by **Shiva Saini**. Backend in Python/Flask, frontend in vanilla
JS with no framework or build step. Uses GitHub, Vercel, Netlify, and
Render's own REST APIs directly, Neon for token storage, Firestore for
chat history, and OpenRouter for the AI-assisted parts of the pipeline.
