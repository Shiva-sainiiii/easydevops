<div align="center">

# ⚡ DevOps Agent — Multi-Tenant (Vercel Edition)

### Har user apna khud ka GitHub connect karta hai — ab Vercel pe, bina cold start ke.

</div>

---

## 🧠 Ye Version Kyun

Ye [multi-tenant DevOps Agent](../multitenant-agent) ka Vercel-compatible rewrite hai.
Same OAuth flow, same per-user isolation, same features — sirf storage aur session
layer badli hai, kyunki Vercel serverless hai aur Render jaisa persistent process
nahi chalata.

| | Render version | Ye (Vercel version) |
|---|---|---|
| Hosting model | Persistent process | Serverless functions |
| Cold start | ~30-50s (free tier idle ke baad) | ~1-3s (function cold start) |
| Token storage | SQLite (local file) | Neon Postgres (managed, network DB) |
| Session | Flask server-side session | Stateless signed cookie (itsdangerous) |

**Kyun badlaav zaroori tha:** Vercel har request ek fresh, isolated environment me
chalata hai — koi shared disk ya memory nahi hoti do requests ke beech. SQLite file
jo ek request me likhi jaati, agli request tak gayab ho jaati. Isliye:
- Token store ab **Neon** (managed Postgres) me hai — asli network database jo
  kisi bhi single function invocation se independent survive karta hai
- Session ab **stateless** hai — `user_id` seedha ek signed cookie me hota hai
  (tamper-proof, kyunki `itsdangerous` se cryptographically signed hai), server
  ko kahi kuch lookup nahi karna padta ye jaanne ke liye ki request kiski hai

## 🔐 Auth Flow (updated)

```
User "Connect GitHub" dabata hai
        │
        ▼
GitHub OAuth authorize page
        │  state ek SIGNED COOKIE me set hota hai (session nahi)
        ▼
/auth/github/callback?code=...&state=...
        │  cookie se state verify → code ko access_token se exchange
        │  GitHub se identity fetch (github_id, login, avatar)
        ▼
Neon Postgres: upsert user row, token Fernet-encrypted
        │
        ▼
user_id ek SIGNED COOKIE me set (itsdangerous, 30-day expiry)
        │
        ▼
Har /chat request → cookie se user_id verify (DB lookup nahi, sirf
                     signature check) → phir DB se decrypt token
                   → USER KE APNE GitHub account pe API call
```

## ⚙️ Setup

### 1. Neon Postgres database banao
1. [neon.tech](https://neon.tech) pe free account banao
2. New Project → database create ho jayega
3. **Connection string** copy karo (pooled connection string use karo agar option
   mile — Vercel ke serverless pattern ke liye better hai)

### 2. GitHub OAuth App banao
1. GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App**
2. **Homepage URL**: tumhara Vercel URL (e.g. `https://your-app.vercel.app`)
3. **Authorization callback URL**: `https://your-app.vercel.app/auth/github/callback`
4. Client ID aur Client Secret copy karo

### 3. Env vars set karo

```bash
cp .env.example .env
# .env me sab values fill karo
```

Required:
```
FLASK_SECRET_KEY=          # python -c "import secrets; print(secrets.token_hex(32))"
FERNET_KEY=                # python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
OPENROUTER_KEY=
APP_BASE_URL=               # no trailing slash, must match GitHub OAuth App callback
DATABASE_URL=                # Neon connection string
```

### 4. Local test

```bash
pip install -r requirements.txt
python server.py
```

Local testing ke liye: GitHub OAuth App ka callback `http://localhost:5000/auth/github/callback`
rakho, `APP_BASE_URL=http://localhost:5000` aur `FLASK_ENV=development` set karo
(taaki cookie ka Secure flag na lage — wo plain HTTP pe login block kar deta).

### 5. Vercel pe deploy

1. Ye repo GitHub pe push karo
2. Vercel dashboard → New Project → apna repo import karo
3. **Environment Variables** section me upar wale saare vars add karo (production URL ke saath)
4. Deploy
5. GitHub OAuth App ka callback URL bhi ab production Vercel URL pe update karo
6. `APP_BASE_URL` bhi Vercel dashboard me production URL pe update karo, phir redeploy

`vercel.json` already isi repo me hai — Vercel ko batata hai ki `server.py` ek
Python/Flask app hai aur saare routes usi pe jaayein.

## 🎯 Is Pass Me Kya Hai

**GitHub**: create/delete/list repos, file CRUD, repo info, zip upload/download,
folder upload — sab GitHub OAuth se, tumhare khud ke account me.

**Vercel**: list/import/deploy/delete projects, env vars get/set. GitHub jaisा
OAuth nahi hai — Vercel **manual API token paste** se connect hota hai (user menu
me "Connect Vercel"). Wajah: Vercel ka "Sign in with Vercel" OAuth flow
identity-focused hai (login ke liye), deployment-management API access ke liye
docs clear nahi hain — ek open community thread khud isी gap ko flag karta hai.
Manual token guaranteed kaam karta hai aur user kabhi bhi apne Vercel dashboard
se revoke kar sakta hai.

**Netlify**: list/get-info/delete sites, env vars get/set. Same reasoning as
Vercel — **manual Personal Access Token paste** (user menu me "Connect
Netlify"). Netlify docs khud PAT ko third-party-tool ke liye first-class,
recommended path bataते hain.

**Render**: list/delete services, env vars get/set, deploy trigger. Render ka
public OAuth hai hi nahi (docs khud confirm karte hain) — isliye **manual API
Key paste** hi is platform ke liye sirf option hai, koi alternative nahi.

**UI — hamburger drawer**: multi-session chat history (naye chat start karo,
purani chats me switch karo, delete karo — sab localStorage me, per-device),
Connected Apps panel (GitHub/Vercel/Netlify status + connect/disconnect ek
jagah se), aur Settings (haptics, auto-scroll, confirm-before-clear — sab
chhote client-side preferences). Har message pe copy button hai, aur agar
koi message fail ho ya user ka apna message ho to retry button bhi.

## 🔒 Security Notes

- Session cookie **signed hai, encrypted nahi** — usme sirf `user_id` (ek number)
  hota hai, koi sensitive data nahi, isliye signing (tamper-proofing) kaafi hai
- GitHub tokens Postgres me Fernet-encrypted rehte hain, DB compromise pe bhi
  plaintext nahi milega
- OAuth CSRF-state bhi ab ek short-lived (10 min) signed cookie me hai, session
  ki jagah — same security guarantee, bas stateless
- Koi bhi user ka GitHub token kabhi doosre user ke request me use nahi hota —
  `execute_command()` ab bhi structurally isolated hai
- Destructive-action confirm-tokens `user_id`-bound hain
- Logout par: cookie clear + DB se us user ka row delete (GitHub aur Vercel dono tokens turant discard)
- Vercel token bhi Postgres me Fernet-encrypted rehta hai, GitHub token jaisा hi. "Disconnect Vercel" se turant clear ho jata hai (GitHub session affect nahi hota)
- Vercel token save karne se pehle ek validation call (`GET /v2/user`) hoti hai — invalid/expired token save hi nahi hoga

## 🛠️ Tech Stack

```
Backend    →  Python · Flask · Flask-CORS · Neon (Postgres) · psycopg2
Auth       →  GitHub OAuth Apps + itsdangerous (stateless signed cookies)
Encryption →  cryptography (Fernet) — tokens at rest
Frontend   →  Vanilla HTML/CSS/JS (same UI as other versions)
Hosting    →  Vercel (Python serverless functions)
AI Layer   →  OpenRouter (shared infra, app-level key)
```
