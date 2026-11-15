/**
 * AUTH — stateless signed-cookie sessions + per-request user lookup.
 *
 * Session cookie mein sirf `user_id` hota hai, itsdangerous-compatible
 * format mein signed (lib/itsdangerous.ts). Cookie ka naam, salt, max-age
 * sab Flask version jaisa hai, isliye logged-in users logged-in hi rahenge.
 */
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";

import { config } from "@/lib/config";
import { getUserById, type UserRow } from "@/lib/db";
import { BadSignature, URLSafeTimedSerializer } from "@/lib/itsdangerous";

export const SESSION_COOKIE_NAME = "agent_session";
export const OAUTH_STATE_COOKIE_NAME = "agent_oauth_state";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
export const OAUTH_STATE_MAX_AGE_SECONDS = 60 * 10; // 10 minutes

// Do alag salts: OAuth state cookie aur login cookie cryptographically alag rehte hain
let _sessionSigner: URLSafeTimedSerializer | undefined;
let _oauthStateSigner: URLSafeTimedSerializer | undefined;
const sessionSigner = () =>
  (_sessionSigner ??= new URLSafeTimedSerializer(config.FLASK_SECRET_KEY, "agent-session"));
const oauthStateSigner = () =>
  (_oauthStateSigner ??= new URLSafeTimedSerializer(config.FLASK_SECRET_KEY, "agent-oauth-state"));

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const, // Lax (Strict nahi) taaki GitHub redirect pe cookie saath aaye
    secure: config.IS_PROD,
    maxAge,
    path: "/",
  };
}

export function setSessionCookie(resp: NextResponse, userId: number | string, version = 0): void {
  // v sirf tab jab >0: version 0 pe cookie bilkul purane (Flask) format jaisi rehti hai
  const token = sessionSigner().dumps(version > 0 ? { user_id: userId, v: version } : { user_id: userId });
  resp.cookies.set(SESSION_COOKIE_NAME, token, cookieOptions(SESSION_MAX_AGE_SECONDS));
}

export function clearSessionCookie(resp: NextResponse): void {
  resp.cookies.set(SESSION_COOKIE_NAME, "", { path: "/", maxAge: 0 });
}

/** Signed cookie verify karke {userId, v} deta hai, warna null. DB hit nahi hota. */
export async function readSession(): Promise<{ userId: number | string; v: number } | null> {
  const raw = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!raw) return null;
  try {
    const data = sessionSigner().loads(raw, SESSION_MAX_AGE_SECONDS);
    if (!data?.user_id) return null;
    return { userId: data.user_id, v: Number(data.v ?? 0) || 0 };
  } catch (e) {
    if (e instanceof BadSignature) return null;
    throw e;
  }
}

export async function readSessionUserId(): Promise<number | string | null> {
  return (await readSession())?.userId ?? null;
}

export function setOauthStateCookie(resp: NextResponse, state: string): void {
  const token = oauthStateSigner().dumps({ state });
  resp.cookies.set(OAUTH_STATE_COOKIE_NAME, token, cookieOptions(OAUTH_STATE_MAX_AGE_SECONDS));
}

/** Expected state padhta hai aur cookie ko delete kar deta hai (single-use). */
export async function readAndClearOauthStateCookie(resp: NextResponse): Promise<string | null> {
  const raw = (await cookies()).get(OAUTH_STATE_COOKIE_NAME)?.value;
  resp.cookies.set(OAUTH_STATE_COOKIE_NAME, "", { path: "/", maxAge: 0 });
  if (!raw) return null;
  try {
    const data = oauthStateSigner().loads(raw, OAUTH_STATE_MAX_AGE_SECONDS);
    return data?.state ?? null;
  } catch (e) {
    if (e instanceof BadSignature) return null;
    throw e;
  }
}

/** Logged-in user ki DB row, ya null. */
export async function currentUser(): Promise<UserRow | null> {
  const session = await readSession();
  if (!session) return null;
  const user = await getUserById(session.userId);
  if (!user) return null;
  // "Logout everywhere" ke baad purani cookies (purana version) yahin reject ho jati hain
  if (session.v !== (user.session_version ?? 0)) return null;
  return user;
}

/**
 * Login nahi hai to 401 response deta hai, warna null.
 * Handler mein: `const err = await requireLogin(); if (err) return err;`
 * security.ts lazily import hota hai (circular import se bachne ke liye,
 * jaise Flask version mein).
 */
export async function requireLogin(): Promise<NextResponse | null> {
  if (!(await currentUser())) {
    const { safeJsonify } = await import("@/lib/security");
    return safeJsonify(
      {
        reply: "🔒 Pehle GitHub se connect karo. Login button dabao.",
        action: "auth_required",
      },
      401
    );
  }
  return null;
}
