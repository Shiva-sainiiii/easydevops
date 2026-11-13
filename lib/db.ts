/**
 * TOKEN STORE — Neon Postgres, encrypted at rest.
 *
 * Ek row per user: GitHub identity + encrypted GitHub/Vercel/Netlify/Render
 * tokens. Table schema aur encryption format Flask version jaisa hi hai,
 * isliye purana data seedha chalega.
 *
 * Flask mein init_db() app startup pe chalta tha. Yahan har query se pehle
 * `ensureDb()` ek baar (per cold start) schema create/migrate kar deta hai.
 */
import { Pool } from "pg";

import { config } from "@/lib/config";
import { Fernet } from "@/lib/fernet";

export interface UserRow {
  id: number;
  github_id: number | string;
  github_login: string;
  avatar_url: string | null;
  github_token_encrypted: Buffer;
  vercel_token_encrypted: Buffer | null;
  vercel_username: string | null;
  netlify_token_encrypted: Buffer | null;
  netlify_email: string | null;
  render_token_encrypted: Buffer | null;
  render_email: string | null;
  created_at: Date;
  updated_at: Date;
}

let _fernet: Fernet | undefined;
function fernet(): Fernet {
  return (_fernet ??= new Fernet(config.FERNET_KEY));
}

let _pool: Pool | undefined;
function pool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: 3,
      idleTimeoutMillis: 10_000,
    });
    // Neon idle connection kaat de to process crash na ho
    _pool.on("error", () => {});
  }
  return _pool;
}

let _init: Promise<void> | undefined;

async function runInit(): Promise<void> {
  const p = pool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        github_id BIGINT UNIQUE NOT NULL,
        github_login TEXT NOT NULL,
        avatar_url TEXT,
        github_token_encrypted BYTEA NOT NULL,
        vercel_token_encrypted BYTEA,
        vercel_username TEXT,
        netlify_token_encrypted BYTEA,
        netlify_email TEXT,
        render_token_encrypted BYTEA,
        render_email TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Migration-safe: purani table ho to missing columns add ho jaayein
  await p.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS vercel_token_encrypted BYTEA");
  await p.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS vercel_username TEXT");
  await p.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS netlify_token_encrypted BYTEA");
  await p.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS netlify_email TEXT");
  await p.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS render_token_encrypted BYTEA");
  await p.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS render_email TEXT");

  // AI Gateway: har user ki apni AI keys (encrypted) + active provider/model
  await p.query(`
    CREATE TABLE IF NOT EXISTS ai_keys (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        key_encrypted BYTEA NOT NULL,
        key_hint TEXT NOT NULL,
        label TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query("CREATE INDEX IF NOT EXISTS ai_keys_user_provider_idx ON ai_keys (user_id, provider)");
  await p.query(`
    CREATE TABLE IF NOT EXISTS ai_settings (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        active_provider TEXT,
        models JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

export function initDb(): Promise<void> {
  if (!_init) {
    _init = runInit().catch((e) => {
      _init = undefined; // agli request pe dobara try ho
      throw e;
    });
  }
  return _init;
}

async function query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  await initDb();
  const res = await pool().query(text, params as any[]);
  return res.rows as T[];
}

export function encryptToken(rawToken: string): Buffer {
  return fernet().encrypt(Buffer.from(rawToken, "utf-8"));
}

export function decryptToken(blob: Buffer | Uint8Array | null | undefined): string | null {
  if (!blob) return null;
  try {
    return fernet().decrypt(Buffer.from(blob)).toString("utf-8");
  } catch {
    return null; // InvalidToken
  }
}

export async function upsertUser(
  githubId: number | string,
  githubLogin: string,
  avatarUrl: string | null,
  githubToken: string
): Promise<number> {
  const encrypted = encryptToken(githubToken);
  const rows = await query<{ id: number }>(
    `
    INSERT INTO users (github_id, github_login, avatar_url, github_token_encrypted)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (github_id) DO UPDATE SET
        github_login = EXCLUDED.github_login,
        avatar_url = EXCLUDED.avatar_url,
        github_token_encrypted = EXCLUDED.github_token_encrypted,
        updated_at = NOW()
    RETURNING id
    `,
    [githubId, githubLogin, avatarUrl, encrypted]
  );
  return rows[0].id;
}

export async function getUserById(userId: number | string): Promise<UserRow | null> {
  const rows = await query<UserRow>("SELECT * FROM users WHERE id = $1", [userId]);
  return rows[0] ?? null;
}

export async function getUserGithubToken(userId: number | string): Promise<string | null> {
  const user = await getUserById(userId);
  if (!user) return null;
  return decryptToken(user.github_token_encrypted);
}

export async function deleteUser(userId: number | string): Promise<void> {
  await query("DELETE FROM users WHERE id = $1", [userId]);
}

// ---- Vercel ----

export async function setVercelToken(userId: number | string, vercelToken: string, vercelUsername: string | null) {
  const encrypted = encryptToken(vercelToken);
  await query(
    `UPDATE users SET vercel_token_encrypted = $1, vercel_username = $2, updated_at = NOW() WHERE id = $3`,
    [encrypted, vercelUsername, userId]
  );
}

export async function clearVercelToken(userId: number | string) {
  await query(
    `UPDATE users SET vercel_token_encrypted = NULL, vercel_username = NULL, updated_at = NOW() WHERE id = $1`,
    [userId]
  );
}

export function getUserVercelToken(user: UserRow): string | null {
  if (!user.vercel_token_encrypted) return null;
  return decryptToken(user.vercel_token_encrypted);
}

// ---- Netlify ----

export async function setNetlifyToken(userId: number | string, netlifyToken: string, netlifyEmail: string | null) {
  const encrypted = encryptToken(netlifyToken);
  await query(
    `UPDATE users SET netlify_token_encrypted = $1, netlify_email = $2, updated_at = NOW() WHERE id = $3`,
    [encrypted, netlifyEmail, userId]
  );
}

export async function clearNetlifyToken(userId: number | string) {
  await query(
    `UPDATE users SET netlify_token_encrypted = NULL, netlify_email = NULL, updated_at = NOW() WHERE id = $1`,
    [userId]
  );
}

export function getUserNetlifyToken(user: UserRow): string | null {
  if (!user.netlify_token_encrypted) return null;
  return decryptToken(user.netlify_token_encrypted);
}

// ---- Render ----

export async function setRenderToken(userId: number | string, renderToken: string, renderEmail: string | null) {
  const encrypted = encryptToken(renderToken);
  await query(
    `UPDATE users SET render_token_encrypted = $1, render_email = $2, updated_at = NOW() WHERE id = $3`,
    [encrypted, renderEmail, userId]
  );
}

export async function clearRenderToken(userId: number | string) {
  await query(
    `UPDATE users SET render_token_encrypted = NULL, render_email = NULL, updated_at = NOW() WHERE id = $1`,
    [userId]
  );
}

export function getUserRenderToken(user: UserRow): string | null {
  if (!user.render_token_encrypted) return null;
  return decryptToken(user.render_token_encrypted);
}

// ---- AI Gateway (per-user AI keys) ----

export interface AiKeyRow {
  id: number;
  provider: string;
  key_hint: string;
  label: string | null;
}

export interface AiSettings {
  active_provider: string | null;
  models: Record<string, string>;
}

/** Keys ki list — sirf hint (last 4) ke saath, asli key kabhi nahi. */
export async function listAiKeys(userId: number | string): Promise<AiKeyRow[]> {
  return query<AiKeyRow>(
    "SELECT id, provider, key_hint, label FROM ai_keys WHERE user_id = $1 ORDER BY id",
    [userId]
  );
}

/** Ek provider ki saari keys decrypt karke (sirf server ke andar use ke liye). */
export async function getAiKeys(userId: number | string, provider: string): Promise<string[]> {
  const rows = await query<{ key_encrypted: Buffer }>(
    "SELECT key_encrypted FROM ai_keys WHERE user_id = $1 AND provider = $2 ORDER BY id",
    [userId, provider]
  );
  const out: string[] = [];
  for (const r of rows) {
    const k = decryptToken(r.key_encrypted);
    if (k) out.push(k);
  }
  return out;
}

/** Key save karta hai. Same key pehle se ho to duplicate nahi banata. */
export async function addAiKey(
  userId: number | string,
  provider: string,
  rawKey: string,
  label: string | null
): Promise<void> {
  const existing = await getAiKeys(userId, provider);
  if (existing.includes(rawKey)) return;
  await query(
    "INSERT INTO ai_keys (user_id, provider, key_encrypted, key_hint, label) VALUES ($1, $2, $3, $4, $5)",
    [userId, provider, encryptToken(rawKey), rawKey.slice(-4), label]
  );
}

/** Key hatata hai. Provider ki last key gayi to uska saved model / active selection bhi saaf. */
export async function deleteAiKey(userId: number | string, keyId: number): Promise<void> {
  const rows = await query<{ provider: string }>(
    "DELETE FROM ai_keys WHERE id = $1 AND user_id = $2 RETURNING provider",
    [keyId, userId]
  );
  if (!rows.length) return;
  const provider = rows[0].provider;
  const left = await query("SELECT 1 FROM ai_keys WHERE user_id = $1 AND provider = $2 LIMIT 1", [userId, provider]);
  if (left.length) return;

  const st = await getAiSettings(userId);
  const models = { ...st.models };
  delete models[provider];
  let active = st.active_provider;
  if (active === provider) {
    const others = await query<{ provider: string }>(
      "SELECT DISTINCT provider FROM ai_keys WHERE user_id = $1 ORDER BY provider",
      [userId]
    );
    active = others.length ? others[0].provider : null;
  }
  await query(
    `INSERT INTO ai_settings (user_id, active_provider, models) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET active_provider = $2, models = $3::jsonb, updated_at = NOW()`,
    [userId, active, JSON.stringify(models)]
  );
}

export async function getAiSettings(userId: number | string): Promise<AiSettings> {
  const rows = await query<{ active_provider: string | null; models: Record<string, string> | null }>(
    "SELECT active_provider, models FROM ai_settings WHERE user_id = $1",
    [userId]
  );
  const r = rows[0];
  return { active_provider: r?.active_provider ?? null, models: (r?.models as Record<string, string>) ?? {} };
}

/** Active provider + uska model save karta hai (baaki providers ke saved models same rehte hain). */
export async function setAiActive(userId: number | string, provider: string, model: string): Promise<void> {
  const st = await getAiSettings(userId);
  const models = { ...st.models, [provider]: model };
  await query(
    `INSERT INTO ai_settings (user_id, active_provider, models) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET active_provider = $2, models = $3::jsonb, updated_at = NOW()`,
    [userId, provider, JSON.stringify(models)]
  );
}
