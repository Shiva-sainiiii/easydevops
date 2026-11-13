/**
 * Route handlers ke chhote shared helpers (Flask ke request.json / _require_user jaise).
 */
import type { NextResponse } from "next/server";

import { currentUser } from "@/lib/auth";
import type { UserRow } from "@/lib/db";
import { safeJsonify } from "@/lib/security";

/** Flask ka `request.json or {}` — bad/empty/non-object body pe {} deta hai. */
export async function readJsonBody(req: Request): Promise<Record<string, any>> {
  let raw: unknown = null;
  try {
    raw = await req.json();
  } catch {
    raw = null;
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, any>) : {};
}

/** provider_routes / session_routes ka 401 (chhota message, requireLogin se alag). */
export async function authRequired401(): Promise<NextResponse> {
  return safeJsonify({ reply: "🔒 Pehle GitHub se connect karo.", action: "auth_required" }, 401);
}

/** Login hai to {user}, nahi to {err: 401 response}. */
export async function requireUser(): Promise<{ user: UserRow; err: null } | { user: null; err: NextResponse }> {
  const user = await currentUser();
  if (!user) return { user: null, err: await authRequired401() };
  return { user, err: null };
}
