/**
 * CHAT SESSION STORE — Firestore (Firebase Admin SDK, sirf backend se).
 *
 * Collection layout Flask version jaisa hi hai, isliye purani chats dikhengi:
 *   chat_sessions/{user_id}/sessions/{session_id} -> {id, title, messages: [...], updatedAt}
 *   chat_sessions/{user_id}                       -> {activeSessionId}
 *
 * Flask mein init_firestore() startup pe chalta tha; yahan pehli use pe
 * lazily initialize hota hai.
 */
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore";

import { config } from "@/lib/config";

export const SESSIONS_MAX = 50; // purane localStorage SESSIONS_MAX jaisa
export const SESSION_MSG_MAX = 200; // purane localStorage SESSION_MSG_MAX jaisa

let _db: Firestore | undefined;

export function initFirestore(): Firestore {
  if (_db) return _db;
  let serviceAccountInfo: any;
  try {
    serviceAccountInfo = JSON.parse(config.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON — paste the *entire* contents " +
        "of the downloaded service-account key file as-is, not a file path."
    );
  }
  const app = getApps()[0] ?? initializeApp({ credential: cert(serviceAccountInfo) });
  _db = getFirestore(app);
  return _db;
}

function sessionsCollection(userId: number | string) {
  return initFirestore().collection("chat_sessions").doc(String(userId)).collection("sessions");
}

function metaDoc(userId: number | string) {
  return initFirestore().collection("chat_sessions").doc(String(userId));
}

/**
 * Firestore Timestamp -> epoch milliseconds. Frontend (timeAgo, sessions.sort)
 * plain number expect karta hai, isliye yahin normalize hota hai.
 */
function epochMs(value: any): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value.toMillis === "function") return value.toMillis();
  return null;
}

function normalizeSession(doc: Record<string, any>): Record<string, any> {
  doc.updatedAt = epochMs(doc.updatedAt);
  return doc;
}

export interface SessionsState {
  sessions: Record<string, any>[];
  activeSessionId: string | null;
}

/** {sessions: [...], activeSessionId} — purane localStorage blob jaisi shape. */
export async function getSessionsState(userId: number | string): Promise<SessionsState> {
  const snap = await sessionsCollection(userId)
    .orderBy("updatedAt", "desc")
    .limit(SESSIONS_MAX)
    .get();
  const sessions = snap.docs.map((d) => normalizeSession(d.data()));

  const meta = await metaDoc(userId).get();
  let activeId: string | null = meta.exists ? (meta.data()?.activeSessionId ?? null) : null;

  // Saved active id agar kisi existing session ko point nahi karta to sabse recent wala
  if (!activeId || !sessions.some((s) => s.id === activeId)) {
    activeId = sessions.length ? sessions[0].id : null;
  }
  return { sessions, activeSessionId: activeId };
}

export async function createSession(userId: number | string, sessionId: string, title = "Nayi Chat") {
  const doc = { id: sessionId, title, messages: [] as any[], updatedAt: FieldValue.serverTimestamp() };
  await sessionsCollection(userId).doc(sessionId).set(doc);
  await setActiveSession(userId, sessionId);
  return doc;
}

/**
 * Ek message append karta hai, SESSION_MSG_MAX tak trim karta hai, updatedAt
 * bump karta hai, aur pehla user message ho to title set karta hai.
 */
export async function appendMessage(userId: number | string, sessionId: string, entry: Record<string, any>) {
  const ref = sessionsCollection(userId).doc(sessionId);
  let snap = await ref.get();
  if (!snap.exists) {
    await createSession(userId, sessionId);
    snap = await ref.get();
  }

  const data = snap.data() ?? {};
  let messages: any[] = data.messages ?? [];
  messages.push(entry);
  if (messages.length > SESSION_MSG_MAX) {
    messages = messages.slice(-SESSION_MSG_MAX);
  }

  const update: Record<string, any> = { messages, updatedAt: FieldValue.serverTimestamp() };
  if (messages.length === 1 && entry.role === "user") {
    const title = String(entry.content ?? "").trim().replace(/\n/g, " ");
    // Python code points ke hisaab se slice karta tha (emoji safe)
    const chars = Array.from(title);
    update.title = chars.length > 42 ? chars.slice(0, 42).join("") + "…" : title;
  }
  await ref.update(update);
}

export async function setActiveSession(userId: number | string, sessionId: string) {
  await metaDoc(userId).set({ activeSessionId: sessionId }, { merge: true });
}

export async function deleteSession(userId: number | string, sessionId: string) {
  await sessionsCollection(userId).doc(sessionId).delete();
}

export async function clearSessionMessages(userId: number | string, sessionId: string) {
  await sessionsCollection(userId).doc(sessionId).update({
    messages: [],
    title: "Nayi Chat",
    updatedAt: FieldValue.serverTimestamp(),
  });
}
