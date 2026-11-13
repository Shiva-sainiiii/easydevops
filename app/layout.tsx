import type { Metadata, Viewport } from "next";

import "./globals.css";

const TITLE = "Easy DevOps — GitHub, Vercel, Netlify & Render se Chat karo";

export const metadata: Metadata = {
  title: TITLE,
  description:
    "Easy DevOps ek AI-powered chat tool hai jo GitHub repos banata hai, Vercel/Netlify pe deploy karta hai, aur Render services manage karta hai — sab kuch tumhare khud ke account me, Hindi/English chat commands se. Mobile-first, secure OAuth login.",
  keywords:
    "devops agent, ai devops tool, github automation, vercel deploy chatbot, netlify deployment ai, render service manager, chat based deployment, devops chatbot, github repo manager ai, hinglish devops tool",
  authors: [{ name: "Shiva Saini" }],
  robots: "index, follow",
  alternates: { canonical: "https://easydevops.vercel.app/" },
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
    title: TITLE,
    description:
      "Ek chat interface se GitHub repos banao, Vercel/Netlify pe deploy karo, aur Render services manage karo — apne khud ke account me, secure OAuth ke saath.",
    images: ["https://multitenant-agent.vercel.app/android-chrome-512x512.png"],
    url: "https://multitenant-agent.vercel.app/",
    siteName: "Easy DevOps",
  },
  twitter: {
    card: "summary",
    title: TITLE,
    description:
      "Ek chat interface se GitHub repos banao, Vercel/Netlify pe deploy karo, aur Render services manage karo — apne khud ke account me.",
    images: ["https://multitenant-agent.vercel.app/android-chrome-512x512.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#060c0d",
};

// AMOLED theme ka flash na ho: script.js ke applyTheme() jaisa hi logic, paint se pehle.
const EARLY_THEME = `try{var s=JSON.parse(localStorage.getItem('devops_agent_settings_v1')||'{}');document.documentElement.setAttribute('data-theme',s.amoled?'amoled':'default')}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <script dangerouslySetInnerHTML={{ __html: EARLY_THEME }} />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
