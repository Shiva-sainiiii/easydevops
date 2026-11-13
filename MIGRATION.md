# Easy DevOps: Flask -> Next.js (TypeScript) migration

Status: Phase 5 done (cleanup docs). Migration complete. Naya repo me migration ban raha hai.

## Phases
1. Inventory - done
2. Backend core (lib/) - done: config, http shim, fernet, itsdangerous, db, auth, security, firestore, providers
3. Commands: 3a-3d sab done
4. API routes (/chat, /api/*, auth, sessions, files) - pending
5. Frontend (script.js / style.css -> components) - pending
6. vercel.json cutover + old Flask files hatana - pending

## Compatibility (verify ho chuka hai)
- Env vars same naam: FLASK_SECRET_KEY, FERNET_KEY, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET,
  OPENROUTER_KEY, APP_BASE_URL, DATABASE_URL, FIREBASE_SERVICE_ACCOUNT_JSON (aur FLASK_ENV).
- Login cookie (agent_session) Python itsdangerous ke saath dono taraf compatible -> users logout nahi honge.
- Neon mein stored encrypted tokens (Fernet) naye code se decrypt hote hain, aur ulta bhi.
- Postgres table aur Firestore collections (chat_sessions/...) same hain.

## Chhote farq (jaan-bujh ke)
- Env validation ab pehli use pe hoti hai (import-time nahi), warna `next build` env ke bina toot jaata. Error messages same.
- DB: har query pe naya connection ki jagah chhota connection pool (max 3).
- Python `requests` ka timeout (headers aane tak) lib/http.ts mein same semantics ke saath.

## Phase 3b-3d notes
- Naye lib files: commands/{executor,ai_fallback,code_generate,bulk_actions,env_transfer,render_blueprint,render_create_service,pyutil,errors}.ts,
  lib/zip.ts (built-in zlib se chhota zip reader, koi nayi npm dependency nahi), lib/api-utils.ts.
- Routes (same URL paths): /chat, /api/repos, /api/vercel-projects, /api/vercel-repo-linked, /api/netlify-sites,
  /api/render-services, /api/repo-folders, /api/repo-files, /api/file-source (GET+POST), /api/bulk-action, /api/list-files,
  /api/vercel/deploy-events, /api/vercel/analyze-error, /upload, /upload-zip, /upload-env, /download, /download-env, /download-repo-zip.
- BUG-1 (old code, abhi waisa hi): executor.py `time` import nahi karta -> VERCEL_ROLLBACK / VERCEL_LIST_DEPLOYMENTS error.
  Fix: lib/commands/executor.ts me `FIX_TIME_BUG = true`.
- Vercel request body limit ~4.5MB hai (Flask version me bhi same thi) - bade upload/zip pehle bhi fail hote the.
- X-Env-Export-Warning header me em-dash '—' ko '-' kiya (Node headers sirf latin-1 lete hain).

## Phase 4 notes (frontend)
- app/layout.tsx: metadata/SEO/fonts (index.html <head> se), early AMOLED theme script.
- app/page.tsx + components/app-markup.ts: index.html ka <body> markup bilkul same (inline onclick handlers waise hi).
- components/ScriptLoader.tsx: public/script.js (original, unchanged) load karta hai aur DOMContentLoaded dispatch karta hai.
- app/globals.css = easydevops-updated/style.css (maxDuration + .attach-sheet desktop card dono apply).
- Faithful shim approach: script.js ke ~211 functions React state me nahi toote — UI/behavior 100% same. Baad me chahe to alag-alag components me todna possible hai.

## Phase 5: GitHub web pe DELETE karne wali files (ZIP delete nahi kar sakta)

MUST (warna build/deploy toot sakta hai):
1. vercel.json            <- sabse zaroori, nahi to Vercel Python builder chalayega
2. app.py
3. requirements.txt
4. server/                (poora folder: __init__.py, auth.py, config.py, db.py, firestore_db.py, security.py,
                           commands/*, providers/*, routes/*)
5. easydevops-updated/    (poora folder)
6. index.html, script.js, style.css   (ab components/app-markup.ts, public/script.js, app/globals.css me hain)

OPTIONAL (root ke duplicate static files — ab public/ me hain, Next root se serve nahi karta):
android-chrome-192x192.png, android-chrome-512x512.png, apple-touch-icon.png, favicon-16x16.png,
favicon-32x32.png, favicon-48x48.png, favicon.ico, logo-mark.png, robots.txt, sitemap.xml,
site.webmanifest, googledecff8a97b3b7f45.html

Folder delete: GitHub me folder kholo -> upar "..." -> "Delete directory".
README.md aur .env.example is ZIP se overwrite ho jayenge.

## Pending (tumhari 'haan' ka wait)
- BUG-1: executor.ts me FIX_TIME_BUG = true (Vercel rollback / list deployments fix).
