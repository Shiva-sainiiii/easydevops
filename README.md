<div align="center">

# ⚡ Easy DevOps

### Chat karke apna GitHub, Vercel, Netlify aur Render control karo — Hinglish me, phone se.

</div>

---

Multi-tenant, chat-driven DevOps assistant. Har user apna **khud ka** GitHub (OAuth) connect karta hai, aur
optionally apna Vercel / Netlify / Render (API token paste karke). Phir English ya Hinglish chat se: repos banao/delete
karo, files padho/likho, deploy karo, env vars manage karo, rollback karo, `render.yaml` generate karo, aur AI se
multi-file code changes (branch + PR) karwao.

> **Migration note:** ye project pehle Flask (Python) + vanilla JS tha. Ab **Next.js 14+ App Router + TypeScript**
> hai. API paths, JSON response shapes, DB tables, Firestore layout aur env var names **same** hain.

## Tech stack

| Layer | Kya |
|---|---|
| Framework | Next.js (App Router), TypeScript (non-strict ok), Vercel pe deploy |
| Backend | Route Handlers (`app/**/route.ts`) + shared code `lib/` |
| DB | Neon Postgres (`pg`, global pool) — users + Fernet-encrypted tokens |
| Chat sessions | Firestore (`firebase-admin`, sirf backend) |
| AI | OpenRouter |
| Auth | GitHub OAuth + signed cookie `agent_session` (itsdangerous-compatible) |
| Frontend | Original UI: `components/app-markup.ts` (HTML) + `public/script.js` + `app/globals.css` |

## Project structure

```
app/
  layout.tsx, page.tsx, globals.css      # UI shell (SEO metadata, markup, CSS)
  chat/route.ts                          # POST /chat
  auth/...                               # GitHub OAuth login/callback/logout
  api/                                   # me, sessions, providers, repos, file-source, bulk-action, vercel/*, ...
  upload/ upload-zip/ upload-env/ download/ download-env/ download-repo-zip/
components/
  app-markup.ts, ScriptLoader.tsx        # index.html markup + script.js loader
lib/
  config.ts db.ts fernet.ts itsdangerous.ts auth.ts security.ts firestore.ts http.ts ...
  providers/ (github, vercel, netlify, render)
  commands/  (intent_parser, confirmation, executor, ai_fallback, code_generate,
              bulk_actions, env_transfer, render_blueprint, render_create_service)
public/                                  # script.js, favicons, robots.txt, sitemap.xml, manifest
```

## Command flow (`/chat`)

1. Auth check → 2. confirmed destructive replay (sha256 confirm token, user-bound) →
3. regex `parseIntent` (Hinglish + English) → direct command, ya CREATE/EDIT_FILE & CODE_GENERATE (AI-assisted) →
4. koi rule match na ho to OpenRouter chat; agar AI reply me command ho to wahi path (`extractCommand`).

Destructive commands (`DELETE_*`, `VERCEL_ROLLBACK`, `BULK_DELETE_*`) hamesha confirmation maangte hain.
`CODE_GENERATE` default me nayi branch + PR banata hai (direct commit sirf "directly commit karo" jaise phrase pe).

## Safety

- Har response secrets se redact hota hai (`lib/security.ts`), tokens sirf Fernet-encrypted store hote hain.
- Har GitHub write se pehle `safeRepoPath()` (path traversal / `.github/` block), zip-slip guard `/upload-zip` me.
- Commands kabhi arbitrary `owner` nahi lete — hamesha logged-in user ka login.

## Deploy (sirf phone se)

1. GitHub repo me ye files push karo (Phase ZIPs), purani Python files delete karo (`MIGRATION.md` ki list).
2. Vercel → Project → Settings → **Framework Preset = Next.js** (Build/Output/Install commands khaali / default).
3. Environment Variables: `.env.example` ke sab naam, **purani values hi** (`FERNET_KEY` same hona zaroori).
4. `APP_BASE_URL` = tumhara live URL; GitHub OAuth App ka callback = `{APP_BASE_URL}/auth/github/callback`.
5. Redeploy.

## Test checklist (phone/desktop)

1. Home page khule, login gate dikhe; "Connect GitHub" → GitHub → wapas app, avatar dikhe.
2. `/api/me` me `logged_in: true`.
3. Chat: `list repos` → repo cards. `repo info <name>`.
4. `create repo test-xyz` → bane; `delete repo test-xyz` → "Pakka?" confirm → Yes → delete.
5. File: `create file a.txt in test-xyz` (AI content), inline editor se edit+save, download file.
6. Upload ek chhoti file, phir ek chhota `.zip` (≤4MB — Vercel body limit).
7. Vercel connect (token paste) → `list vercel projects`, `deploy <project>`; live log drawer chale.
8. Netlify/Render connect → list; Render env get/set; `.env` upload + download.
9. "build login page in <repo>" → naya branch + PR link aaye (CODE_GENERATE).
10. Chat sessions: naya chat, refresh ke baad history wahi (Firestore), clear chat.
11. Logout → login gate wapas.

## Known limitations

- Vercel request body ~4.5MB: usse bade upload/zip fail honge (pehle bhi yahi tha).
- Env export: Vercel/Netlify values API se nahi milti (sirf `KEY=` scaffold); Render me full values.
- Old Flask cookie format ke baare me: lib/itsdangerous.ts compatible hai, isliye users logout nahi hone chahiye.

Made by Shiva Saini.
