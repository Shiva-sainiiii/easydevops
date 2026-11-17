import type { Metadata, Viewport } from "next";

import "./globals.css";

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://easydevops.vercel.app").replace(/\/+$/, "");
const TITLE = "Easy DevOps — Deploy from chat: GitHub, Vercel, Netlify & Render";
// ~155 chars: Google snippet me poora dikhta hai
const DESCRIPTION =
  "Create GitHub repos, deploy to Vercel, Netlify & Render and manage env vars from a simple chat — no CLI needed. Built for students. English & Hinglish.";
const OG_IMAGE = { url: "/og-image.png", width: 1200, height: 630, alt: "Easy DevOps — deploy from chat, no CLI" };

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: TITLE, template: "%s | Easy DevOps" },
  description: DESCRIPTION,
  applicationName: "Easy DevOps",
  authors: [{ name: "Shiva Saini", url: "https://github.com/Shiva-sainiiii" }],
  creator: "Shiva Saini",
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 } },
  verification: { google: "P01x9soQMkl7WRKM-EGjKulOwN_Tqe-ytv7ZaOpKFLI" },
  icons: {
    icon: [
      { url: "/favicon.ico", type: "image/x-icon" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-48x48.png", sizes: "48x48", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  manifest: "/site.webmanifest",
  openGraph: {
    type: "website",
    siteName: "Easy DevOps",
    title: TITLE,
    description: DESCRIPTION,
    url: SITE_URL + "/",
    locale: "en_IN",
    images: [OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: [OG_IMAGE.url],
  },
};

// maximumScale hata diya: pinch-zoom band karna accessibility issue hai (Lighthouse/WCAG).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#09090b",
};

// AMOLED theme ka flash na ho: script.js ke applyTheme() jaisa hi logic, paint se pehle.
const EARLY_THEME = `try{var s=JSON.parse(localStorage.getItem('devops_agent_settings_v1')||'{}');document.documentElement.setAttribute('data-theme',s.amoled?'amoled':'default')}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        <script dangerouslySetInnerHTML={{ __html: EARLY_THEME }} />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
