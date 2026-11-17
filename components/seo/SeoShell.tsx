import Link from "next/link";
import type { ReactNode } from "react";

import { NAV_LINKS } from "@/lib/seo-content";

/**
 * Public SEO pages ka shell. App ka globals.css `html, body { overflow: hidden }` lagata hai, isliye
 * .seo-root khud fixed + scrollable hai (app ke CSS ko chhue bina).
 */
export default function SeoShell({ children }: { children: ReactNode }) {
  return (
    <div className="seo-root">
      <header className="seo-header">
        <Link href="/" className="seo-brand" aria-label="Easy DevOps">
          <img src="/logo-mark.png" alt="" width={28} height={28} />
          <span>Easy DevOps</span>
        </Link>
        <nav aria-label="Main" className="seo-nav">
          {NAV_LINKS.map((l) => (
            <Link key={l.path} href={l.path}>
              {l.label}
            </Link>
          ))}
        </nav>
        <Link href="/" className="seo-cta">
          Open the app
        </Link>
      </header>
      <main className="seo-main">{children}</main>
      <footer className="seo-footer">
        <nav aria-label="Footer">
          {NAV_LINKS.map((l) => (
            <Link key={l.path} href={l.path}>
              {l.label}
            </Link>
          ))}
          <Link href="/about">About</Link>
          <Link href="/privacy">Privacy</Link>
        </nav>
        <p>Easy DevOps — deploy from chat, no CLI. Built by Shiva Saini.</p>
      </footer>
    </div>
  );
}
