import crypto from "node:crypto";
import { NextResponse } from "next/server";

import { setOauthStateCookie } from "@/lib/auth";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const GITHUB_OAUTH_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
// 'repo' = repos pe full read/write; 'delete_repo' alag scope hai (repo delete ke liye)
const GITHUB_OAUTH_SCOPES = "repo,delete_repo";

// Python urllib.parse.quote (safe="/") jaisa
function pyQuote(s: string): string {
  return encodeURIComponent(s)
    .replace(/%2F/g, "/")
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

export async function GET() {
  const state = crypto.randomBytes(24).toString("base64url"); // secrets.token_urlsafe(24)
  const redirectUri = `${config.APP_BASE_URL}/auth/github/callback`;
  const params: Record<string, string> = {
    client_id: config.GITHUB_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: GITHUB_OAUTH_SCOPES,
    state,
    allow_signup: "true",
  };
  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${pyQuote(String(v))}`)
    .join("&");

  const resp = new NextResponse(null, {
    status: 302,
    headers: { Location: `${GITHUB_OAUTH_AUTHORIZE_URL}?${query}` },
  });
  setOauthStateCookie(resp, state);
  return resp;
}
