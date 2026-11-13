/**
 * SECRET REDACTION — defense in depth.
 *
 * Response bhejne se pehle har string value se secrets scrub hote hain:
 * app-level secrets, is request ke user ke decrypt kiye hue tokens, aur
 * token-jaise patterns (GitHub PAT/OAuth, OpenRouter, Render, Netlify, private keys).
 *
 * Yahin safeRepoPath() bhi hai: GitHub pe har write (CREATE/EDIT/DELETE FILE,
 * codegen commit, /upload, /upload-zip) se pehle path-traversal guard.
 */
import { NextResponse } from "next/server";

import { currentUser } from "@/lib/auth";
import { config } from "@/lib/config";
import {
  decryptToken,
  getUserNetlifyToken,
  getUserRenderToken,
  getUserVercelToken,
} from "@/lib/db";

const SECRET_PATTERNS: RegExp[] = [
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g, // OAuth-issued GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-or-v1-[A-Za-z0-9]{20,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /Bearer\s+[A-Za-z0-9\-_.]{15,}/gi,
  /rnd_[A-Za-z0-9]{20,}/g,
  /nfp_[A-Za-z0-9]{20,}/g, // Netlify personal access tokens
  /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/g, // Firebase/GCP keys
];

function appSecrets(): string[] {
  return [
    config.GITHUB_CLIENT_SECRET,
    config.OPENROUTER_KEY,
    config.FERNET_KEY,
    config.FLASK_SECRET_KEY,
    config.DATABASE_URL,
    config.FIREBASE_SERVICE_ACCOUNT_JSON,
  ].filter((s): s is string => !!s);
}

/** App secrets, current user token (agar diya ho) aur secret-shaped strings hata deta hai. */
export function redact<T>(text: T, extraSecrets: string[] = []): T {
  if (!text || typeof text !== "string") return text;
  let out: string = text;
  for (const secret of [...appSecrets(), ...extraSecrets]) {
    if (secret && secret.length > 6) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out as unknown as T;
}

/** NextResponse.json() ka wrapper jo payload ki har string value redact karta hai. */
export async function safeJsonify(payload: unknown, status = 200, headers?: HeadersInit): Promise<NextResponse> {
  const user = await currentUser();
  const extra: string[] = [];
  if (user) {
    const gh = decryptToken(user.github_token_encrypted);
    if (gh) extra.push(gh);
    const vc = getUserVercelToken(user);
    if (vc) extra.push(vc);
    const nl = getUserNetlifyToken(user);
    if (nl) extra.push(nl);
    const rd = getUserRenderToken(user);
    if (rd) extra.push(rd);
  }

  const scrub = (obj: unknown): unknown => {
    if (typeof obj === "string") return redact(obj, extra);
    if (Array.isArray(obj)) return obj.map(scrub);
    if (obj && typeof obj === "object" && Object.getPrototypeOf(obj) === Object.prototype) {
      return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, scrub(v)]));
    }
    return obj;
  };
  return NextResponse.json(scrub(payload), { status, headers });
}

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

/**
 * GitHub contents/tree API mein use hone se pehle path normalize + validate karta hai.
 *
 * Reject karta hai: empty path, kisi bhi ".." segment wala path, absolute-jaise
 * path ("~" ya "C:"), aur ".github/" ke andar ke paths.
 * Success pe clean, forward-slash path return karta hai.
 */
export function safeRepoPath(rawPath: unknown): string {
  if (rawPath === null || rawPath === undefined) throw new UnsafePathError("path missing");
  let path = String(rawPath).trim().replace(/\\/g, "/");
  path = path.replace(/^\/+/, "");
  if (!path) throw new UnsafePathError("path empty");
  if (path.startsWith("~") || /^[a-zA-Z]:/.test(path)) {
    throw new UnsafePathError("absolute-looking path not allowed");
  }

  const cleaned: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw new UnsafePathError("path traversal ('..') not allowed");
    cleaned.push(seg);
  }
  if (cleaned.length === 0) throw new UnsafePathError("path empty after normalization");
  if (cleaned[0] === ".github") {
    throw new UnsafePathError("writes under .github/ are not allowed via chat/codegen");
  }
  return cleaned.join("/");
}
