/**
 * SEO constants — ek hi jagah (layout, pages, JSON-LD, tests sab yahin se padhte hain).
 * Pure module (koi import nahi).
 */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://easydevops.vercel.app").replace(/\/+$/, "");
export const SITE_NAME = "Easy DevOps";
export const SITE_TAGLINE = "Deploy from chat — GitHub, Vercel, Netlify & Render, no CLI";
export const SITE_DESCRIPTION =
  "Easy DevOps lets students and beginners create GitHub repos, deploy to Vercel, Netlify and Render, and manage env vars from a simple chat — no CLI, no switching platforms.";
export const AUTHOR = { name: "Shiva Saini", url: "https://github.com/Shiva-sainiiii" };
export const OG_IMAGE = { url: "/og-image.png", width: 1200, height: 630, alt: "Easy DevOps — deploy from chat, no CLI" };
export const LAST_UPDATED = "2026-11-16";

export const abs = (path: string): string => SITE_URL + (path.startsWith("/") ? path : "/" + path);
