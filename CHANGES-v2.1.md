# v2.1 — multi-step prompts + Tier-1 security

## Bug fix (asli issue)
"Create a repo name "practice" and add index.html with <code>" pehle sirf `CREATE_REPO name` chalata tha.
- `intent_parser.ts`: CREATE_REPO ab `name`/`naam`/quotes samajhta hai; "bna de / bana do / bnado" jaise Hinglish roop; stopwords naam nahi bante.
- `intent_parser.ts`: `parseIntentEx` — match ke baad bacha text (leftover) bhi batata hai; quotes strip; file path ka casing (README.md) bacha rehta hai.
- NEW `chain.ts`: multi-step splitter + rule-based resolver (0 AI).
- NEW `plan_runner.ts`: steps sequentially, fail pe stop, new-repo 404 retry, checklist reply.
- NEW `planner.ts`: AI sirf last resort (ek chhota call, code AI ko nahi jaata, output validated).
- `app/chat/route.ts`: classify -> chain / single / needs_ai / none.

## Tier 1 security
- HMAC + expiry + single-use confirm token (`confirmation.ts`, `db.ts`).
- `middleware.ts`: Origin check, headers, IP rate limit. `ratelimit.ts`: Upstash/in-memory.
- `risk.ts`: tiers; AI-origin writes need confirm.
- Session revocation (`auth.ts`, `db.ts`, `auth/logout-all`, callback).
- `config.ts`: full env validation + `FERNET_KEYS_OLD`; `db.ts`: MultiFernet.
- Decrypt-fail pe `deleteUser` hata diya.
- Codegen prompt: repo content = untrusted data.

## Frontend (public/script.js, minimal)
- Confirm button `confirm_verb: "run"` ke liye "Haan, Chalao" + `plan_done`/`plan_failed` colors.

## Ab dhyan dene wali baatein
- `/auth/logout` abhi bhi user row **delete** karta hai (provider tokens + AI keys saaf). Agar ye intentional nahi hai to batao, soft-logout bana dunga.
- Naya DB table/column apne aap bante hain (`ensureDb`): `users.session_version`, `used_confirm_tokens`.
- Deploy ke baad purane khule confirm buttons (pehle ke token) ek baar "match nahi hua" denge — dobara command bhejo.
