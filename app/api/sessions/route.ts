import { randomBytes } from "node:crypto";

import { createSession, getSessionsState } from "@/lib/firestore";
import { requireUser } from "@/lib/route-utils";
import { safeJsonify } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** {sessions: [...], activeSessionId} — purane localStorage blob jaisi shape. */
export async function GET() {
  const { user, err } = await requireUser();
  if (err) return err;
  const state = await getSessionsState(user.id);
  return safeJsonify(state);
}

/** Nayi khaali session banata hai aur use active kar deta hai. */
export async function POST() {
  const { user, err } = await requireUser();
  if (err) return err;
  const sessionId = "sess_" + randomBytes(8).toString("hex"); // uuid4().hex[:16]
  const doc = await createSession(user.id, sessionId);
  // serverTimestamp sentinel JSON mein nahi jaata -> epoch ms (frontend yahan POST nahi karta)
  return safeJsonify({ ...doc, updatedAt: Date.now() });
}
