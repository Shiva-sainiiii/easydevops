import { NextResponse } from "next/server";

import { readAndClearOauthStateCookie, setSessionCookie } from "@/lib/auth";
import { config } from "@/lib/config";
import { upsertUser } from "@/lib/db";
import { get, post } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const GITHUB_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";

// Flask redirect() jaisa 302 + relative Location
function redirectTo(location: string): NextResponse {
  return new NextResponse(null, { status: 302, headers: { Location: location } });
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;

  const error = sp.get("error");
  if (error) return redirectTo(`/?auth_error=${encodeURIComponent(error)}`);

  // Final redirect pehle bana lo taaki state-cookie delete isi pe lag sake (Flask jaisa)
  const redirectResp = redirectTo("/");
  const returnedState = sp.get("state");
  const expectedState = await readAndClearOauthStateCookie(redirectResp);
  if (!returnedState || !expectedState || returnedState !== expectedState) {
    return redirectTo("/?auth_error=state_mismatch");
  }

  const code = sp.get("code");
  if (!code) return redirectTo("/?auth_error=no_code");

  const tokenR = await post(GITHUB_OAUTH_TOKEN_URL, {
    headers: { Accept: "application/json" },
    data: {
      client_id: config.GITHUB_CLIENT_ID,
      client_secret: config.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${config.APP_BASE_URL}/auth/github/callback`,
    },
    timeout: 15,
  });
  const tokenData = tokenR.json();
  const accessToken = tokenData?.access_token;
  if (!accessToken) {
    return redirectTo(`/?auth_error=${encodeURIComponent(tokenData?.error || "token_exchange_failed")}`);
  }

  // Token kis user ka hai — github_id stable key hai (login badal sakta hai)
  const whoR = await get("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json" },
    timeout: 15,
  });
  if (whoR.status_code !== 200) return redirectTo("/?auth_error=identity_fetch_failed");

  const who = whoR.json();
  const userId = await upsertUser(who.id, who.login, who.avatar_url ?? null, accessToken);

  setSessionCookie(redirectResp, userId);
  return redirectResp;
}
