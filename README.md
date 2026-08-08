<div align="center">

# ⚡ DevOps Agent — Multi-Tenant

### Ek chat interface, jisme har user apna khud ka GitHub connect karta hai.

*Portfolio/LinkedIn pe link share karne layak version — koi shared credential nahi, har visitor ka action unke hi GitHub account me hota hai.*

</div>

---

## 🧠 Ye Alag Kyun Hai

Ye [personal DevOps Agent](../devops-agent) ka standalone cousin hai — same Hinglish chat UI,
lekin fundamentally different trust model:

| | Personal Agent | Ye (Multi-Tenant) |
|---|---|---|
| GitHub access | Tumhara apna `.env` token | Har user apna OAuth se connect karta hai |
| Kaun kya control karta hai | Sirf tum | Jo bhi login karta hai, apna hi account |
| Link share kar sakte ho? | ❌ Nahi — tumhare account pe access | ✅ Haan — har user sirf apna khud dekhta/badalta hai |
| Token storage | Env var (deploy-time secret) | Per-user, encrypted at rest (runtime data) |

## 🔐 Auth Flow

```
User "Connect GitHub" dabata hai
        │
        ▼
GitHub OAuth authorize page (state=random-token via session)
        │  user apna GitHub login karke permission deta hai
        ▼
/auth/github/callback?code=...&state=...
        │  state verify → code ko access_token se exchange
        │  GitHub se identity fetch (github_id, login, avatar)
        ▼
SQLite: upsert user row, token Fernet-encrypted
        │
        ▼
Session cookie set (httponly, signed) → user_id
        │
        ▼
Har /chat request → session se user_id → DB se decrypt token
                   → USER KE APNE GitHub account pe API call
```

Koi bhi command kabhi bhi kisi aur user ke token se nahi chalta — `execute_command()`
har call me explicitly `owner` (GitHub login) + `gh_token` leta hai, dono current
session se aate hain, kabhi request body se nahi.

## ⚙️ Setup

### 1. GitHub OAuth App banao
1. GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App**
2. **Homepage URL**: tumhara deployed URL (e.g. `https://your-app.onrender.com`)
3. **Authorization callback URL**: `https://your-app.onrender.com/auth/github/callback`
4. Client ID aur Client Secret copy karo

### 2. Env vars set karo

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
```

### 3. Run

```bash
pip install -r requirements.txt
python server.py
```

Local testing: GitHub OAuth App ka callback URL `http://localhost:5000/auth/github/callback`
rakho aur `APP_BASE_URL=http://localhost:5000` set karo (aur `FLASK_ENV=development` taaki
cookie ka Secure flag na lage, jo plain HTTP pe login block kar deta).

### 4. Deploy (Render/Vercel/etc.)

- Sab env vars production dashboard me set karo (same names)
- `APP_BASE_URL` production URL pe update karo
- GitHub OAuth App ka callback URL bhi production URL pe update karo
- ⚠️ **SQLite persistence**: agar host ka filesystem ephemeral hai (jaise Render free
  tier bina disk ke), to redeploy pe saare connected users ka token store reset ho
  jayega — sab dubara login karenge. Real usage ke liye persistent disk mount karo,
  ya SQLite ko Postgres se replace karo.

## 🎯 Is Pass Me Kya Hai

Pehla pass sirf **GitHub** commands cover karta hai (jitne single-user version me
the, wahi subset): create/delete/list repos, list/read/create/edit/delete files,
repo info, zip download, file upload. Vercel aur Render OAuth alag passes me aayenge —
Render ka public OAuth abhi utna standard nahi hai, to uske liye shayad "apna API
key khud paste karo" wala manual flow better rahega bajaye full OAuth ke.

## 🔒 Security Notes

- Koi bhi user ka GitHub token kabhi doosre user ke request me use nahi hota —
  `execute_command()` structurally isolated hai (owner + token dono current
  session se aate hain)
- Tokens SQLite me Fernet-encrypted rehte hain, plaintext nahi
- Session cookies httponly + signed (Flask ka `secret_key`) — JS se access
  nahi ho sakte, tamper-proof hain
- Destructive actions (delete repo/file) ka confirm-token ab `user_id` se bhi
  bound hai — ek user ka confirm token doosre ke against replay nahi ho sakta
- Redaction layer ab request-time pe current user ka actual token bhi scrub
  karta hai (fixed list ki jagah), kyunki tokens ab runtime data hain, startup
  config nahi
- Logout par: session clear + DB se us user ka row delete (token turant discard)

## 🛠️ Tech Stack

```
Backend    →  Python · Flask · Flask-CORS · SQLite · cryptography (Fernet)
Frontend   →  Vanilla HTML/CSS/JS (same UI as personal agent)
Auth       →  GitHub OAuth Apps (authorization code flow)
AI Layer   →  OpenRouter (shared infra, app-level key — never sees user tokens)
```
