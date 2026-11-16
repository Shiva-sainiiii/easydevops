# v2.3 — har reply pe "Rules vs AI" badge + Usage Dashboard

## Per-message badge
Har agent reply ke label me ab dikhta hai:
- `⚡ Rules · 0 AI`  — command parser (regex) se ho gaya, AI call nahi hui
- `⚡+🤖 Rules + AI · N calls` — command rules se, content/plan ke liye AI
- `🤖 AI · <model>` — AI fallback se jawab
Hover karne pe provider, model, tokens, AI time. Reload ke baad bhi badge bacha rehta hai (entry me `usage` save hota hai).

## Usage Dashboard (sidebar -> "Usage Dashboard" ya profile menu)
- Aaj / is mahine: total requests, bina AI ke kitne (%), AI involved, AI API calls
- Requests per minute (abhi, last 60 min chart, 24h peak), per day (30 din chart), per month table
- Free limit meters: provider-wise per-minute aur per-day usage vs limit (limit editable, browser me save; defaults approx hain)
- Model wise calls / tokens / 429 count

## Kaise kaam karta hai
- `lib/usage.ts`: /chat request ka scope (AsyncLocalStorage). `aiChat` (lib/ai.ts) har provider HTTP attempt record karta hai
  (429 retry / key fallback samet — wahi provider ke rate-limit me gini jaati hain).
- `lib/security.ts` safeJsonify: response me `usage` attach + chat row log.
- DB: naya table `usage_log` (auto-create). Sirf counts/metadata — prompts, replies, keys store nahi hote. github_id se bandha hai
  (logout ke baad bhi history rehti hai), 400 din baad purani rows saaf.
- `GET /api/usage?tz=Asia/Kolkata` (30 req/min limit).

## Dhyan dene wali baatein
- Counts sirf Easy DevOps se gayi AI calls ke hain. Wahi key kahin aur use hui to provider ka asli quota zyada kharch hoga.
- Limits ke defaults (Google 10/min 250/day, OpenRouter 20/min 50/day) sirf approx hain — providers badalte rehte hain, apne dashboard se verify karke edit karo.
- Purani (v2.3 se pehle ki) replies pe badge nahi dikhega.
- Bulk-action / upload routes abhi usage me nahi gine jaate (wo AI use nahi karte).
