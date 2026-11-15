/**
 * MIDDLEWARE — har request se pehle:
 *  1. CSRF/Origin check: POST/PUT/PATCH/DELETE sirf apni hi site (APP_BASE_URL / same host) se allowed.
 *  2. Coarse IP rate limit (mutating requests) — user-level limits routes ke andar hain.
 *  3. Safe security headers. (Strict script-src CSP jaanbujh ke nahi: public/script.js inline onclick use karta hai.)
 */
import { NextResponse, type NextRequest } from "next/server";

import { rateLimit, tooManyRequests } from "@/lib/ratelimit";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function allowedHosts(req: NextRequest): Set<string> {
  const hosts = new Set<string>([req.nextUrl.host]);
  const fwd = req.headers.get("x-forwarded-host");
  if (fwd) hosts.add(fwd.split(",")[0].trim());
  const base = process.env.APP_BASE_URL;
  if (base) {
    try {
      hosts.add(new URL(base).host);
    } catch {
      /* ignore */
    }
  }
  return hosts;
}

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

export async function middleware(req: NextRequest) {
  if (UNSAFE.has(req.method)) {
    const origin = req.headers.get("origin");
    const site = req.headers.get("sec-fetch-site");
    let bad = false;
    if (origin) {
      try {
        bad = !allowedHosts(req).has(new URL(origin).host);
      } catch {
        bad = true; // "null" origin etc.
      }
    } else if (site === "cross-site") {
      bad = true;
    }
    if (bad) {
      return NextResponse.json({ reply: "🔒 Request origin allowed nahi hai.", action: "error" }, { status: 403 });
    }

    const rl = await rateLimit(`ip:${clientIp(req)}:mut`, 300, 60);
    if (!rl.ok) return tooManyRequests(rl);
  }

  const res = NextResponse.next();
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.headers.set("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
  if (req.nextUrl.protocol === "https:") {
    res.headers.set("Strict-Transport-Security", "max-age=15552000");
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|js|css|txt|xml|webmanifest|map)$).*)"],
};
